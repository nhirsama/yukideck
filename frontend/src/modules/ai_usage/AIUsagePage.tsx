import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, ChevronLeft, ChevronRight, Cpu, Layers, Settings, Terminal, X } from 'lucide-react';
import { aiUsageApi, type BreakdownItem, type HeatmapDay } from './api';
import { detectBrowserTimezone, formatDateTime, formatPercent, formatTokens, formatUSD, localDateISO } from './format';

const SERIES_COLORS = [
  '#38bdf8',
  '#60a5fa',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#f472b6',
  '#2dd4bf',
  '#cbd5e1',
];

const HEATMAP_CLASSES = [
  'bg-zinc-100',
  'bg-sky-100',
  'bg-sky-200',
  'bg-sky-400',
  'bg-sky-500',
];

type RangePreset = '7d' | '30d' | '90d' | '365d';

export default function AIUsagePage() {
  const tz = useMemo(() => detectBrowserTimezone(), []);
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [startDate, setStartDate] = useState(() => localDateISO(-29));
  const [endDate, setEndDate] = useState(() => localDateISO(0));
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [project, setProject] = useState('');

  const [granularity, setGranularity] = useState<'hour' | 'day' | 'week' | 'month'>('day');
  const [groupBy, setGroupBy] = useState<'agent' | 'model' | 'device' | 'project' | 'total'>('agent');
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens');
  const [breakdownTab, setBreakdownTab] = useState<'agent' | 'model' | 'device' | 'project'>('model');

  const [page, setPage] = useState(1);
  const [selectedSession, setSelectedSession] = useState<{ sessionId: string; deviceId: string } | null>(null);

  const applyPreset = (p: RangePreset) => {
    setPreset(p);
    const days = p === '7d' ? 6 : p === '30d' ? 29 : p === '90d' ? 89 : 364;
    setStartDate(localDateISO(-days));
    setEndDate(localDateISO(0));
    setPage(1);
  };

  const queryParams = useMemo(
    () => ({
      start: startDate,
      end: endDate,
      tz,
      agent: agent || undefined,
      model: model || undefined,
      device_id: deviceId || undefined,
      project: project || undefined,
    }),
    [startDate, endDate, tz, agent, model, deviceId, project],
  );

  const heatmapParams = useMemo(
    () => ({
      start: localDateISO(-364),
      end: localDateISO(0),
      tz,
      agent: agent || undefined,
      model: model || undefined,
      device_id: deviceId || undefined,
      project: project || undefined,
    }),
    [tz, agent, model, deviceId, project],
  );

  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ['ai-usage', 'summary', queryParams],
    queryFn: () => aiUsageApi.summary(queryParams),
  });

  const { data: trends } = useQuery({
    queryKey: ['ai-usage', 'trends', queryParams, granularity, groupBy],
    queryFn: () => aiUsageApi.trends({ ...queryParams, granularity, group_by: groupBy }),
  });

  const { data: heatmap } = useQuery({
    queryKey: ['ai-usage', 'heatmap', heatmapParams],
    queryFn: () => aiUsageApi.heatmap(heatmapParams),
  });

  const { data: sessionsRes } = useQuery({
    queryKey: ['ai-usage', 'sessions', queryParams, page],
    queryFn: () => aiUsageApi.sessions({ ...queryParams, page, page_size: 15 }),
  });

  const { data: toolsRes } = useQuery({
    queryKey: ['ai-usage', 'tools', queryParams],
    queryFn: () => aiUsageApi.tools(queryParams),
  });

  const { data: sessionDetail, isLoading: loadingDetail } = useQuery({
    queryKey: ['ai-usage', 'session-detail', selectedSession],
    queryFn: () => aiUsageApi.sessionDetail(selectedSession!.sessionId, selectedSession!.deviceId),
    enabled: Boolean(selectedSession),
  });

  const filters = summary?.filters;
  const breakdownItems: BreakdownItem[] = useMemo(() => {
    if (!summary) return [];
    switch (breakdownTab) {
      case 'agent':
        return summary.by_agent;
      case 'device':
        return summary.by_device;
      case 'project':
        return summary.by_project;
      default:
        return summary.by_model;
    }
  }, [summary, breakdownTab]);

  // Build 365-day heatmap grid aligned by week columns
  const heatmapGrid = useMemo(() => {
    const map = new Map<string, HeatmapDay>();
    for (const d of heatmap?.days ?? []) {
      map.set(d.date, d);
    }
    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - 364);
    // rewind to Sunday
    start.setDate(start.getDate() - start.getDay());
    const weeks: { date: string; day?: HeatmapDay }[][] = [];
    const cur = new Date(start);
    while (cur <= today) {
      const col: { date: string; day?: HeatmapDay }[] = [];
      for (let i = 0; i < 7; i++) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const dd = String(cur.getDate()).padStart(2, '0');
        const iso = `${y}-${m}-${dd}`;
        col.push({ date: iso, day: map.get(iso) });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(col);
    }
    return weeks;
  }, [heatmap]);

  const trendPoints = trends?.points ?? [];
  const trendLabelStep = Math.max(1, Math.ceil(trendPoints.length / 10));

  const trendMax = useMemo(() => {
    let max = 0;
    for (const pt of trendPoints) {
      const val = metric === 'cost' ? pt.cost_usd : pt.total_tokens;
      if (val > max) max = val;
    }
    return max;
  }, [trendPoints, metric]);

  const hourMax = useMemo(() => {
    let max = 0;
    for (const h of summary?.by_hour_of_day ?? []) {
      if (h.total_tokens > max) max = h.total_tokens;
    }
    return max;
  }, [summary]);

  const totalPages = Math.max(1, Math.ceil((sessionsRes?.total ?? 0) / (sessionsRes?.page_size ?? 15)));

  const hasActiveFilters = Boolean(agent || model || deviceId || project);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="yd-page-title">AI 用量统计</h1>
        <Link to="/settings?tab=ai-usage" className="yd-btn-secondary">
          <Settings className="h-3.5 w-3.5" />
          配置
        </Link>
      </div>

      {/* Filters */}
      <div className="yd-card p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="yd-segment">
            {(['7d', '30d', '90d', '365d'] as RangePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                className={`yd-segment-btn ${preset === p ? 'yd-segment-active' : 'yd-segment-idle'}`}
              >
                {p === '7d' ? '近 7 天' : p === '30d' ? '近 30 天' : p === '90d' ? '近 90 天' : '近 1 年'}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                setPage(1);
              }}
              className="yd-input-sm tabular-nums"
            />
            <span className="text-xs text-zinc-400">~</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => {
                setEndDate(e.target.value);
                setPage(1);
              }}
              className="yd-input-sm tabular-nums"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="grid flex-1 grid-cols-2 sm:grid-cols-4 gap-2">
            <select
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                setPage(1);
              }}
              className="yd-input-sm w-full"
            >
              <option value="">全部 Agent</option>
              {(filters?.agents ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setPage(1);
              }}
              className="yd-input-sm w-full"
            >
              <option value="">全部模型</option>
              {(filters?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select
              value={deviceId}
              onChange={(e) => {
                setDeviceId(e.target.value);
                setPage(1);
              }}
              className="yd-input-sm w-full"
            >
              <option value="">全部设备</option>
              {(filters?.devices ?? []).map((d) => (
                <option key={d.device_id} value={d.device_id}>
                  {d.name || d.device_id}
                </option>
              ))}
            </select>
            <select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setPage(1);
              }}
              className="yd-input-sm w-full"
            >
              <option value="">全部项目</option>
              {(filters?.projects ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => {
                setAgent('');
                setModel('');
                setDeviceId('');
                setProject('');
                setPage(1);
              }}
              className="yd-btn-ghost shrink-0"
            >
              重置
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="yd-card p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>总 Token 消耗</span>
            <Layers className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="mt-2.5 text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums">
            {loadingSummary ? '—' : formatTokens(summary?.tokens.total_tokens ?? 0)}
          </div>
          <div className="mt-1.5 text-[11px] text-zinc-400 tabular-nums">
            输入 {formatTokens(summary?.tokens.input_tokens ?? 0)} · 输出{' '}
            {formatTokens(summary?.tokens.output_tokens ?? 0)} · 缓存读{' '}
            {formatTokens(summary?.tokens.cache_read_tokens ?? 0)}
          </div>
        </div>

        <div className="yd-card p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>等效 API 费用</span>
            <BarChart3 className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="mt-2.5 text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums">
            {loadingSummary ? '—' : formatUSD(summary?.cost_usd ?? 0)}
          </div>
          <div className="mt-1.5 text-[11px] text-emerald-700 tabular-nums">
            缓存命中率 {formatPercent(summary?.cache_hit_rate ?? 0)} · 节省{' '}
            {formatUSD(summary?.cache_savings_usd ?? 0)}
          </div>
        </div>

        <div className="yd-card p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>会话 / 请求轮次</span>
            <Cpu className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="mt-2.5 text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums">
            {summary?.session_count ?? 0}
            <span className="text-xs font-normal text-zinc-400 ml-1.5">
              / {summary?.request_count ?? 0} 轮
            </span>
          </div>
          <div className="mt-1.5 text-[11px] text-zinc-400 tabular-nums">
            活跃 {summary?.active_days ?? 0} 天 · 子代理 {formatTokens(summary?.subagent_tokens ?? 0)}
          </div>
        </div>

        <div className="yd-card p-4">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>工具调用 / 峰值上下文</span>
            <Terminal className="h-3.5 w-3.5 text-zinc-400" />
          </div>
          <div className="mt-2.5 text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums">
            {summary?.tool_call_count ?? 0}
          </div>
          <div className="mt-1.5 text-[11px] text-zinc-400 tabular-nums">
            单轮最大上下文 {formatTokens(summary?.max_context_tokens ?? 0)}
          </div>
        </div>
      </div>

      {/* Trends Chart */}
      <section className="yd-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-zinc-900">用量趋势</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as 'hour' | 'day' | 'week' | 'month')}
              className="yd-input-sm py-1"
            >
              <option value="hour">按小时</option>
              <option value="day">按天</option>
              <option value="week">按周</option>
              <option value="month">按月</option>
            </select>
            <select
              value={groupBy}
              onChange={(e) =>
                setGroupBy(e.target.value as 'agent' | 'model' | 'device' | 'project' | 'total')
              }
              className="yd-input-sm py-1"
            >
              <option value="agent">按 Agent 堆叠</option>
              <option value="model">按模型堆叠</option>
              <option value="device">按设备堆叠</option>
              <option value="project">按项目堆叠</option>
              <option value="total">总计</option>
            </select>
            <div className="yd-segment">
              <button
                type="button"
                onClick={() => setMetric('tokens')}
                className={`yd-segment-btn py-0.5 ${
                  metric === 'tokens' ? 'yd-segment-active' : 'yd-segment-idle'
                }`}
              >
                Tokens
              </button>
              <button
                type="button"
                onClick={() => setMetric('cost')}
                className={`yd-segment-btn py-0.5 ${
                  metric === 'cost' ? 'yd-segment-active' : 'yd-segment-idle'
                }`}
              >
                费用
              </button>
            </div>
          </div>
        </div>

        {trendPoints.length === 0 ? (
          <div className="h-44 flex items-center justify-center text-xs text-zinc-400">
            选定时间范围内暂无数据
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-zinc-500">
              {(trends?.series_keys ?? []).map((key, idx) => (
                <span key={key} className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: SERIES_COLORS[idx % SERIES_COLORS.length] }}
                  />
                  {key}
                </span>
              ))}
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[480px] pt-3">
                <div className="flex items-end gap-1.5 h-44 border-b border-zinc-100 pb-0.5">
                  {trendPoints.map((pt) => {
                    const totalVal = metric === 'cost' ? pt.cost_usd : pt.total_tokens;
                    const pct = trendMax > 0 ? Math.max(totalVal > 0 ? 2 : 0, (totalVal / trendMax) * 100) : 0;
                    return (
                      <div
                        key={pt.bucket}
                        className="flex-1 min-w-[10px] flex flex-col items-center h-full justify-end group"
                        title={`${pt.bucket}\nTokens: ${formatTokens(pt.total_tokens)}\n费用: ${formatUSD(pt.cost_usd)}\n请求: ${pt.request_count}`}
                      >
                        <div
                          className="w-full max-w-[26px] rounded-t-[4px] overflow-hidden flex flex-col-reverse transition-opacity group-hover:opacity-80"
                          style={{ height: `${pct}%` }}
                        >
                          {(trends?.series_keys ?? []).map((sKey, idx) => {
                            const sv = pt.series[sKey];
                            if (!sv) return null;
                            const v = metric === 'cost' ? sv.cost_usd : sv.total_tokens;
                            if (v <= 0 || totalVal <= 0) return null;
                            return (
                              <div
                                key={sKey}
                                style={{
                                  height: `${(v / totalVal) * 100}%`,
                                  backgroundColor: SERIES_COLORS[idx % SERIES_COLORS.length],
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center gap-1.5 pt-1.5">
                  {trendPoints.map((pt, i) => {
                    const showLabel =
                      i % trendLabelStep === 0 ||
                      (i === trendPoints.length - 1 && trendPoints.length - 1 - Math.floor((trendPoints.length - 1) / trendLabelStep) * trendLabelStep >= Math.ceil(trendLabelStep / 2));
                    return (
                      <div key={pt.bucket} className="flex-1 min-w-[10px] text-center">
                        {showLabel ? (
                          <span className="text-[10px] text-zinc-400 whitespace-nowrap tabular-nums">
                            {pt.bucket.slice(5)}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Heatmap + 24h Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 yd-card p-5 flex flex-col justify-between gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-zinc-800">年度活跃</h2>
            <div className="flex items-center gap-1 text-[10px] text-zinc-400">
              <span>少</span>
              {HEATMAP_CLASSES.map((cls, idx) => (
                <span key={idx} className={`h-2.5 w-2.5 rounded-[2px] ${cls}`} />
              ))}
              <span>多</span>
            </div>
          </div>
          <div
            className="grid w-full gap-[2px] sm:gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${Math.max(heatmapGrid.length, 1)}, minmax(0, 1fr))` }}
          >
            {heatmapGrid.map((week, wi) => (
              <div key={wi} className="grid grid-rows-7 gap-[2px] sm:gap-[3px]">
                {week.map((cell) => {
                  const lvl = cell.day?.level ?? 0;
                  return (
                    <div
                      key={cell.date}
                      className={`w-full aspect-square rounded-[2px] ring-1 ring-inset ring-black/[0.04] transition-opacity hover:opacity-75 ${HEATMAP_CLASSES[lvl] ?? HEATMAP_CLASSES[0]}`}
                      title={
                        cell.day
                          ? `${cell.date}: ${formatTokens(cell.day.total_tokens)} · ${formatUSD(cell.day.cost_usd)} · ${cell.day.session_count} 会话`
                          : `${cell.date}: 无记录`
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </section>

        <section className="yd-card p-5 flex flex-col justify-between gap-3">
          <h2 className="text-sm font-medium text-zinc-800">时段分布</h2>
          <div className="flex items-end gap-1 h-24">
            {(summary?.by_hour_of_day ?? []).map((h) => {
              const pct =
                hourMax > 0 ? Math.max(h.total_tokens > 0 ? 5 : 0, (h.total_tokens / hourMax) * 100) : 0;
              return (
                <div
                  key={h.hour}
                  className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end group"
                  title={`${String(h.hour).padStart(2, '0')}:00 — ${formatTokens(h.total_tokens)} · ${formatUSD(h.cost_usd)}`}
                >
                  <div className="w-full flex-1 flex items-end rounded-t bg-[#f1f5f9] overflow-hidden">
                    <div
                      className="w-full rounded-t bg-sky-400 group-hover:bg-sky-500 transition-colors"
                      style={{ height: `${pct}%` }}
                    />
                  </div>
                  <span className="h-3.5 text-[10px] leading-none text-zinc-400 tabular-nums">
                    {h.hour % 4 === 0 ? h.hour : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Breakdown & Tools */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 yd-card p-5 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-zinc-900">多维分布</h2>
            <div className="yd-segment">
              {(
                [
                  ['model', '模型'],
                  ['agent', 'Agent'],
                  ['device', '设备'],
                  ['project', '项目'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setBreakdownTab(k)}
                  className={`yd-segment-btn py-0.5 ${
                    breakdownTab === k ? 'yd-segment-active' : 'yd-segment-idle'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="yd-table">
              <thead className="yd-thead">
                <tr>
                  <th className="py-2 pr-3 font-medium">名称</th>
                  <th className="py-2 pr-3 font-medium text-right">总 Token</th>
                  <th className="py-2 pr-3 font-medium text-right">费用</th>
                  <th className="py-2 pr-3 font-medium text-right">轮次</th>
                  <th className="py-2 font-medium text-right">会话</th>
                </tr>
              </thead>
              <tbody className="yd-tbody tabular-nums">
                {breakdownItems.slice(0, 12).map((item) => (
                  <tr key={item.key} className="hover:bg-zinc-50/70 transition-colors">
                    <td className="py-2.5 pr-3 font-mono text-zinc-800">{item.label}</td>
                    <td className="py-2.5 pr-3 text-right text-zinc-700">
                      {formatTokens(item.total_tokens)}
                    </td>
                    <td className="py-2.5 pr-3 text-right text-zinc-700">{formatUSD(item.cost_usd)}</td>
                    <td className="py-2.5 pr-3 text-right text-zinc-500">{item.request_count}</td>
                    <td className="py-2.5 text-right text-zinc-500">{item.session_count}</td>
                  </tr>
                ))}
                {breakdownItems.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-zinc-400">
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="yd-card p-5 space-y-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-900">工具调用排行</h2>
            <span className="text-[11px] text-zinc-400 tabular-nums">
              共 {toolsRes?.total_calls ?? 0} 次
            </span>
          </div>
          <div className="space-y-3">
            {(toolsRes?.tools ?? []).slice(0, 10).map((t) => (
              <div key={t.name} className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="font-mono text-zinc-800 truncate">{t.name}</span>
                  <span className="text-zinc-500 shrink-0 ml-2 tabular-nums">
                    {t.count} <span className="text-zinc-400">({formatPercent(t.share)})</span>
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-[#f1f5f9] overflow-hidden">
                  <div
                    className="h-full bg-sky-400 rounded-full"
                    style={{ width: `${Math.max(2, t.share * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {(toolsRes?.tools?.length ?? 0) === 0 && (
              <div className="py-6 text-center text-xs text-zinc-400">暂无工具调用记录</div>
            )}
          </div>
        </section>
      </div>

      {/* Sessions Table */}
      <section className="yd-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-zinc-800">会话记录</h2>
            <span className="text-xs text-zinc-400 tabular-nums">
              共 {sessionsRes?.total ?? 0} 条
            </span>
          </div>
          <div className="flex items-center gap-1 text-xs">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="yd-btn-icon border border-zinc-200"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="px-2 text-zinc-500 tabular-nums">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="yd-btn-icon border border-zinc-200"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="yd-table">
            <thead className="yd-thead">
              <tr>
                <th className="py-2 pr-3 font-medium">会话 / 项目</th>
                <th className="py-2 pr-3 font-medium">Agent / 设备</th>
                <th className="py-2 pr-3 font-medium">模型</th>
                <th className="py-2 pr-3 font-medium text-right">总 Token</th>
                <th className="py-2 pr-3 font-medium text-right">费用</th>
                <th className="py-2 pr-3 font-medium text-right">峰值上下文</th>
                <th className="py-2 pr-3 font-medium text-right">工具</th>
                <th className="py-2 font-medium text-right">最近活跃</th>
              </tr>
            </thead>
            <tbody className="yd-tbody tabular-nums">
              {(sessionsRes?.sessions ?? []).map((s) => (
                <tr
                  key={`${s.device_id}-${s.agent}-${s.session_id}`}
                  onClick={() => setSelectedSession({ sessionId: s.session_id, deviceId: s.device_id })}
                  className="hover:bg-zinc-50/80 cursor-pointer transition-colors"
                >
                  <td className="py-2.5 pr-3">
                    <div className="font-mono text-zinc-900">{s.session_id.slice(0, 14)}</div>
                    <div className="text-[11px] text-zinc-400">
                      {s.project || '-'}
                      {s.subagent_count > 0 && (
                        <span className="ml-1.5 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">
                          +{s.subagent_count} 子代理
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="font-medium text-zinc-800">{s.agent}</div>
                    <div className="text-[11px] text-zinc-400">{s.device_name}</div>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-zinc-600 max-w-[180px] truncate">
                    {s.models.join(', ')}
                  </td>
                  <td className="py-2.5 pr-3 text-right text-zinc-700">
                    {formatTokens(s.tokens.total_tokens)}
                  </td>
                  <td className="py-2.5 pr-3 text-right text-zinc-700">{formatUSD(s.cost_usd)}</td>
                  <td className="py-2.5 pr-3 text-right text-zinc-500">
                    {formatTokens(s.max_context_tokens)}
                  </td>
                  <td className="py-2.5 pr-3 text-right text-zinc-500">{s.tool_call_count}</td>
                  <td className="py-2.5 text-right text-zinc-400 whitespace-nowrap">
                    {formatDateTime(s.last_event_at, tz)}
                  </td>
                </tr>
              ))}
              {(sessionsRes?.sessions?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-zinc-400">
                    暂无会话记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Session Detail Drawer */}
      {selectedSession && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/15 backdrop-blur-[2px] flex justify-end"
          onClick={() => setSelectedSession(null)}
        >
          <div
            className="w-full max-w-2xl bg-white h-full overflow-y-auto p-6 shadow-2xl border-l border-zinc-200/80 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2 pb-4 border-b border-zinc-100">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">会话逐小时明细</h3>
                <div className="text-xs font-mono text-zinc-400 mt-0.5 break-all">
                  {selectedSession.sessionId}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSession(null)}
                className="yd-btn-icon"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {loadingDetail || !sessionDetail ? (
              <div className="text-xs text-zinc-400">加载会话明细中...</div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs tabular-nums">
                  <div className="yd-panel-subtle p-3">
                    <div className="text-zinc-500">总 Token</div>
                    <div className="font-semibold text-zinc-900 mt-1 text-sm">
                      {formatTokens(sessionDetail.session.tokens.total_tokens)}
                    </div>
                  </div>
                  <div className="yd-panel-subtle p-3">
                    <div className="text-zinc-500">等效费用</div>
                    <div className="font-semibold text-zinc-900 mt-1 text-sm">
                      {formatUSD(sessionDetail.session.cost_usd)}
                    </div>
                  </div>
                  <div className="yd-panel-subtle p-3">
                    <div className="text-zinc-500">峰值上下文</div>
                    <div className="font-semibold text-zinc-900 mt-1 text-sm">
                      {formatTokens(sessionDetail.session.max_context_tokens)}
                    </div>
                  </div>
                  <div className="yd-panel-subtle p-3">
                    <div className="text-zinc-500">跨度小时 / 子代理</div>
                    <div className="font-semibold text-zinc-900 mt-1 text-sm">
                      {sessionDetail.session.hour_count}h / {sessionDetail.session.subagent_count}
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5">
                  {sessionDetail.slices.map((sl, idx) => (
                    <div
                      key={`${sl.hour_bucket}-${sl.session_id}-${sl.raw_model}-${idx}`}
                      className="yd-card p-3.5 text-xs space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono font-medium text-zinc-900 tabular-nums">
                            {formatDateTime(sl.hour_bucket, tz)}
                          </span>
                          <span className="yd-code">{sl.model}</span>
                          {sl.is_subagent && (
                            <span className="yd-badge yd-badge-amber">
                              子代理 {sl.session_id.slice(0, 8)}
                            </span>
                          )}
                        </div>
                        <span className="font-medium text-zinc-900 tabular-nums">
                          {formatTokens(sl.tokens.total_tokens)} · {formatUSD(sl.cost_usd)}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-500 flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                        <span>输入 {formatTokens(sl.tokens.input_tokens)}</span>
                        <span>输出 {formatTokens(sl.tokens.output_tokens)}</span>
                        <span>缓存读 {formatTokens(sl.tokens.cache_read_tokens)}</span>
                        <span>
                          缓存写 {formatTokens(sl.tokens.cache_write_tokens + sl.tokens.cache_write_1h_tokens)}
                        </span>
                        {sl.tokens.reasoning_tokens > 0 && (
                          <span>思考 {formatTokens(sl.tokens.reasoning_tokens)}</span>
                        )}
                        <span>峰值上下文 {formatTokens(sl.max_context_tokens)}</span>
                        <span>{sl.request_count} 轮</span>
                      </div>
                      {Object.keys(sl.tool_calls || {}).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {Object.entries(sl.tool_calls)
                            .sort((a, b) => b[1] - a[1])
                            .map(([name, cnt]) => (
                              <span
                                key={name}
                                className="rounded bg-zinc-50 border border-zinc-200/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 tabular-nums"
                              >
                                {name} ×{cnt}
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
