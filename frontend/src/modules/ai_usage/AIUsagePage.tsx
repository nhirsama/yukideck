import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, ChevronLeft, ChevronRight, Cpu, Layers, Settings, Terminal, X } from 'lucide-react';
import { aiUsageApi, type BreakdownItem, type HeatmapDay } from './api';
import { detectBrowserTimezone, formatDateTime, formatPercent, formatTokens, formatUSD, localDateISO } from './format';

const SERIES_COLORS = [
  '#0f172a',
  '#2563eb',
  '#10b981',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#64748b',
];

const HEATMAP_CLASSES = [
  'bg-slate-100',
  'bg-emerald-200',
  'bg-emerald-400',
  'bg-emerald-600',
  'bg-emerald-800',
];

type RangePreset = '7d' | '30d' | '90d' | '365d';

export default function AIUsagePage() {
  const [preset, setPreset] = useState<RangePreset>('30d');
  const [startDate, setStartDate] = useState(() => localDateISO(-29));
  const [endDate, setEndDate] = useState(() => localDateISO(0));
  const [tz, setTz] = useState(() => detectBrowserTimezone());
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

  const trendMax = useMemo(() => {
    let max = 0;
    for (const pt of trends?.points ?? []) {
      const val = metric === 'cost' ? pt.cost_usd : pt.total_tokens;
      if (val > max) max = val;
    }
    return max;
  }, [trends, metric]);

  const hourMax = useMemo(() => {
    let max = 0;
    for (const h of summary?.by_hour_of_day ?? []) {
      if (h.total_tokens > max) max = h.total_tokens;
    }
    return max;
  }, [summary]);

  const totalPages = Math.max(1, Math.ceil((sessionsRes?.total ?? 0) / (sessionsRes?.page_size ?? 15)));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">AI 用量统计</h1>
          <p className="text-sm text-slate-500 mt-1">
            多设备、多 Agent 小时 × 会话级 Token、等效费用与工具调用统计
          </p>
        </div>
        <Link
          to="/settings?tab=ai-usage"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <Settings className="h-3.5 w-3.5" />
          设备 / 别名 / 单价设置
        </Link>
      </div>

      {/* Filters */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {(['7d', '30d', '90d', '365d'] as RangePreset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => applyPreset(p)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
                preset === p
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {p === '7d' ? '近 7 天' : p === '30d' ? '近 30 天' : p === '90d' ? '近 90 天' : '近 1 年'}
            </button>
          ))}
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs"
          />
          <span className="text-xs text-slate-400">~</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs"
          />
          <input
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            title="统计时区（IANA）"
            className="w-36 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-mono"
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <select
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs bg-white"
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
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs bg-white"
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
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs bg-white"
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
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs bg-white"
          >
            <option value="">全部项目</option>
            {(filters?.projects ?? []).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>总 Token 消耗</span>
            <Layers className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">
            {loadingSummary ? '...' : formatTokens(summary?.tokens.total_tokens ?? 0)}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            输入 {formatTokens(summary?.tokens.input_tokens ?? 0)} · 输出{' '}
            {formatTokens(summary?.tokens.output_tokens ?? 0)} · 缓存读{' '}
            {formatTokens(summary?.tokens.cache_read_tokens ?? 0)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>等效 API 费用</span>
            <BarChart3 className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">
            {loadingSummary ? '...' : formatUSD(summary?.cost_usd ?? 0)}
          </div>
          <div className="mt-1 text-[11px] text-emerald-700">
            缓存命中率 {formatPercent(summary?.cache_hit_rate ?? 0)} · 节省{' '}
            {formatUSD(summary?.cache_savings_usd ?? 0)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>会话 / 请求轮次</span>
            <Cpu className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">
            {summary?.session_count ?? 0}
            <span className="text-sm font-normal text-slate-500 ml-1.5">
              / {summary?.request_count ?? 0} 轮
            </span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            活跃 {summary?.active_days ?? 0} 天 · 子代理 {formatTokens(summary?.subagent_tokens ?? 0)}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>工具调用 / 峰值上下文</span>
            <Terminal className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">
            {summary?.tool_call_count ?? 0}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            单轮最大上下文 {formatTokens(summary?.max_context_tokens ?? 0)}
          </div>
        </div>
      </div>

      {/* Trends Chart */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">用量趋势</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as 'hour' | 'day' | 'week' | 'month')}
              className="rounded border border-slate-200 px-2 py-1 bg-white"
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
              className="rounded border border-slate-200 px-2 py-1 bg-white"
            >
              <option value="agent">按 Agent 堆叠</option>
              <option value="model">按模型堆叠</option>
              <option value="device">按设备堆叠</option>
              <option value="project">按项目堆叠</option>
              <option value="total">总计</option>
            </select>
            <div className="inline-flex rounded border border-slate-200 overflow-hidden">
              <button
                type="button"
                onClick={() => setMetric('tokens')}
                className={`px-2 py-1 ${metric === 'tokens' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
              >
                Tokens
              </button>
              <button
                type="button"
                onClick={() => setMetric('cost')}
                className={`px-2 py-1 ${metric === 'cost' ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
              >
                费用
              </button>
            </div>
          </div>
        </div>

        {(trends?.points?.length ?? 0) === 0 ? (
          <div className="h-44 flex items-center justify-center text-xs text-slate-400">
            选定时间范围内暂无数据
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 text-[11px] text-slate-600">
              {(trends?.series_keys ?? []).map((key, idx) => (
                <span key={key} className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: SERIES_COLORS[idx % SERIES_COLORS.length] }}
                  />
                  {key}
                </span>
              ))}
            </div>
            <div className="overflow-x-auto">
              <div className="flex items-end gap-1.5 h-48 min-w-[480px] pt-4">
                {(trends?.points ?? []).map((pt) => {
                  const totalVal = metric === 'cost' ? pt.cost_usd : pt.total_tokens;
                  const pct = trendMax > 0 ? Math.max(2, (totalVal / trendMax) * 100) : 0;
                  return (
                    <div
                      key={pt.bucket}
                      className="flex-1 min-w-[14px] flex flex-col items-center gap-1 h-full justify-end group"
                      title={`${pt.bucket}\nTokens: ${formatTokens(pt.total_tokens)}\n费用: ${formatUSD(pt.cost_usd)}\n请求: ${pt.request_count}`}
                    >
                      <div
                        className="w-full max-w-[28px] rounded-t overflow-hidden flex flex-col-reverse"
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
                      <span className="text-[10px] text-slate-400 truncate max-w-full">
                        {pt.bucket.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </section>

      {/* Heatmap + 24h Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">年度每日活跃热力图</h2>
            <span className="text-[11px] text-slate-400">{heatmap?.timezone || tz}</span>
          </div>
          <div className="overflow-x-auto pb-1">
            <div className="inline-flex gap-1">
              {heatmapGrid.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-1">
                  {week.map((cell) => {
                    const lvl = cell.day?.level ?? 0;
                    return (
                      <div
                        key={cell.date}
                        className={`h-3 w-3 rounded-[2px] ${HEATMAP_CLASSES[lvl] ?? HEATMAP_CLASSES[0]}`}
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
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900">24 小时活跃分布</h2>
          <div className="flex items-end gap-1 h-28 pt-2">
            {(summary?.by_hour_of_day ?? []).map((h) => {
              const pct = hourMax > 0 ? Math.max(h.total_tokens > 0 ? 4 : 0, (h.total_tokens / hourMax) * 100) : 0;
              return (
                <div
                  key={h.hour}
                  className="flex-1 flex flex-col items-center gap-1 h-full justify-end"
                  title={`${String(h.hour).padStart(2, '0')}:00 — ${formatTokens(h.total_tokens)} · ${formatUSD(h.cost_usd)}`}
                >
                  <div
                    className="w-full rounded-t bg-slate-800"
                    style={{ height: `${pct}%` }}
                  />
                  {h.hour % 4 === 0 ? (
                    <span className="text-[10px] text-slate-400">{h.hour}</span>
                  ) : (
                    <span className="text-[10px] text-transparent">.</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Breakdown & Tools */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 rounded-xl border border-slate-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">多维分布</h2>
            <div className="flex gap-1 text-xs">
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
                  className={`rounded px-2 py-1 ${
                    breakdownTab === k ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 pr-3 font-medium">名称</th>
                  <th className="py-2 pr-3 font-medium text-right">总 Token</th>
                  <th className="py-2 pr-3 font-medium text-right">费用</th>
                  <th className="py-2 pr-3 font-medium text-right">轮次</th>
                  <th className="py-2 font-medium text-right">会话</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {breakdownItems.slice(0, 12).map((item) => (
                  <tr key={item.key}>
                    <td className="py-2 pr-3 font-mono text-slate-800">{item.label}</td>
                    <td className="py-2 pr-3 text-right">{formatTokens(item.total_tokens)}</td>
                    <td className="py-2 pr-3 text-right">{formatUSD(item.cost_usd)}</td>
                    <td className="py-2 pr-3 text-right">{item.request_count}</td>
                    <td className="py-2 text-right">{item.session_count}</td>
                  </tr>
                ))}
                {breakdownItems.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-slate-400">
                      暂无数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">工具调用排行</h2>
            <span className="text-[11px] text-slate-400">共 {toolsRes?.total_calls ?? 0} 次</span>
          </div>
          <div className="space-y-2.5">
            {(toolsRes?.tools ?? []).slice(0, 10).map((t) => (
              <div key={t.name} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="font-mono text-slate-800 truncate">{t.name}</span>
                  <span className="text-slate-500 shrink-0 ml-2">
                    {t.count} ({formatPercent(t.share)})
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-slate-800 rounded-full"
                    style={{ width: `${Math.max(2, t.share * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {(toolsRes?.tools?.length ?? 0) === 0 && (
              <div className="py-4 text-center text-xs text-slate-400">暂无工具调用记录</div>
            )}
          </div>
        </section>
      </div>

      {/* Sessions Table */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            会话列表（共 {sessionsRes?.total ?? 0} 条，跨日已合并）
          </h2>
          <div className="flex items-center gap-1.5 text-xs">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border border-slate-200 p-1 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-slate-600">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border border-slate-200 p-1 disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 text-slate-500">
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
            <tbody className="divide-y divide-slate-100">
              {(sessionsRes?.sessions ?? []).map((s) => (
                <tr
                  key={`${s.device_id}-${s.agent}-${s.session_id}`}
                  onClick={() => setSelectedSession({ sessionId: s.session_id, deviceId: s.device_id })}
                  className="hover:bg-slate-50 cursor-pointer"
                >
                  <td className="py-2.5 pr-3">
                    <div className="font-mono text-slate-900">{s.session_id.slice(0, 14)}</div>
                    <div className="text-[11px] text-slate-500">
                      {s.project || '-'}
                      {s.subagent_count > 0 && (
                        <span className="ml-1.5 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-600">
                          +{s.subagent_count} 子代理
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="font-medium text-slate-800">{s.agent}</div>
                    <div className="text-[11px] text-slate-500">{s.device_name}</div>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-slate-700 max-w-[180px] truncate">
                    {s.models.join(', ')}
                  </td>
                  <td className="py-2.5 pr-3 text-right">{formatTokens(s.tokens.total_tokens)}</td>
                  <td className="py-2.5 pr-3 text-right">{formatUSD(s.cost_usd)}</td>
                  <td className="py-2.5 pr-3 text-right">{formatTokens(s.max_context_tokens)}</td>
                  <td className="py-2.5 pr-3 text-right">{s.tool_call_count}</td>
                  <td className="py-2.5 text-right text-slate-500 whitespace-nowrap">
                    {formatDateTime(s.last_event_at, tz)}
                  </td>
                </tr>
              ))}
              {(sessionsRes?.sessions?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-slate-400">
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
          className="fixed inset-0 z-50 bg-slate-900/30 flex justify-end"
          onClick={() => setSelectedSession(null)}
        >
          <div
            className="w-full max-w-2xl bg-white h-full overflow-y-auto p-6 shadow-xl space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">会话逐小时明细</h3>
                <div className="text-xs font-mono text-slate-500 mt-0.5">{selectedSession.sessionId}</div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSession(null)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {loadingDetail || !sessionDetail ? (
              <div className="text-xs text-slate-500">加载会话明细中...</div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="text-slate-500">总 Token</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {formatTokens(sessionDetail.session.tokens.total_tokens)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="text-slate-500">等效费用</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {formatUSD(sessionDetail.session.cost_usd)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="text-slate-500">峰值上下文</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {formatTokens(sessionDetail.session.max_context_tokens)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 p-3">
                    <div className="text-slate-500">跨度小时 / 子代理</div>
                    <div className="font-semibold text-slate-900 mt-0.5">
                      {sessionDetail.session.hour_count}h / {sessionDetail.session.subagent_count}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  {sessionDetail.slices.map((sl, idx) => (
                    <div
                      key={`${sl.hour_bucket}-${sl.session_id}-${sl.raw_model}-${idx}`}
                      className="rounded-lg border border-slate-200 p-3 text-xs space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-slate-900">
                            {formatDateTime(sl.hour_bucket, tz)}
                          </span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                            {sl.model}
                          </span>
                          {sl.is_subagent && (
                            <span className="rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[10px] text-amber-800">
                              子代理 {sl.session_id.slice(0, 8)}
                            </span>
                          )}
                        </div>
                        <span className="font-medium text-slate-900">
                          {formatTokens(sl.tokens.total_tokens)} · {formatUSD(sl.cost_usd)}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
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
                                className="rounded bg-slate-50 border border-slate-200 px-1.5 py-0.5 font-mono text-[10px] text-slate-700"
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
