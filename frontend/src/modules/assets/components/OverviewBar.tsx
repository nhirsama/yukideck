import { AlertTriangle, Eye, EyeOff, Plus, RefreshCw, ShieldAlert } from 'lucide-react';
import { InfoTooltip } from '@/components/InfoTooltip';
import { Tooltip } from '@/components/Tooltip';
import {
  formatMoney,
  formatMoneyExact,
  type AssetRates,
  type AssetSettings,
  type AssetSummary,
  type CostPeriod,
  type Currency,
} from '../api';

interface OverviewBarProps {
  summary?: AssetSummary;
  settings: AssetSettings;
  rates?: AssetRates;
  refreshingRates: boolean;
  onUpdateSettings: (patch: Partial<AssetSettings>) => void;
  onRefreshRates: () => void;
  onCreateItem: () => void;
  onFilterWarranty: (status: 'expiring_soon' | 'expired') => void;
}

const CURRENCIES: Currency[] = ['CNY', 'USD', 'EUR'];
const PERIODS: { key: CostPeriod; label: string }[] = [
  { key: 'daily', label: '日均' },
  { key: 'monthly', label: '月均' },
  { key: 'yearly', label: '年均' },
];

export function OverviewBar({
  summary,
  settings,
  rates,
  refreshingRates,
  onUpdateSettings,
  onRefreshRates,
  onCreateItem,
  onFilterWarranty,
}: OverviewBarProps) {
  const cur = settings.display_currency;
  const hidden = settings.hide_amounts;

  const periodCost =
    settings.cost_period === 'monthly'
      ? (summary?.total_monthly_cost ?? 0)
      : settings.cost_period === 'yearly'
        ? (summary?.total_yearly_cost ?? 0)
        : (summary?.total_daily_cost ?? 0);

  const usdInCNY = rates?.rates?.USD ? (1 / rates.rates.USD).toFixed(2) : '--';
  const eurInCNY = rates?.rates?.EUR ? (1 / rates.rates.EUR).toFixed(2) : '--';
  const rateSourceText =
    rates?.source === 'live' ? '实时' : rates?.source === 'cached' ? '缓存' : '参考';

  return (
    <div className="space-y-4">
      {/* Header Row (aligned with PlannerPage) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="yd-page-title">物品资产</h1>
        <button type="button" onClick={onCreateItem} className="yd-btn-primary">
          <Plus className="h-3.5 w-3.5" />
          新建物品
        </button>
      </div>

      {/* Metrics & Quick Controls Card */}
      <div className="yd-card p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-2.5 sm:gap-4 md:grid-cols-2 xl:grid-cols-4">
          {/* Total Asset */}
          <div className="col-span-2 md:col-span-1 rounded-xl bg-[#f8fafc] p-3 sm:p-3.5">
            <div className="flex items-center justify-between text-xs text-zinc-500">
              <span>总资产价值</span>
              <span className="yd-badge yd-badge-neutral">{summary?.total_count ?? 0} 件</span>
            </div>
            <div className="mt-1.5 font-mono text-2xl font-semibold tracking-tight text-zinc-900">
              {formatMoney(summary?.total_asset ?? 0, cur, hidden)}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">
              {settings.exclude_retired ? '已排除退役物品' : '包含退役物品'} · 含不计价物品
            </div>
          </div>

          {/* Period Cost */}
          <div className="col-span-1 rounded-xl bg-[#f8fafc] p-3 sm:p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-1.5 sm:gap-2 text-xs text-zinc-500">
              <span>持有成本</span>
              <div className="yd-segment text-[11px]">
                {PERIODS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => onUpdateSettings({ cost_period: p.key })}
                    className={`yd-segment-btn px-1.5 sm:px-2 py-0.5 ${
                      settings.cost_period === p.key ? 'yd-segment-active' : 'yd-segment-idle'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-1.5 font-mono text-lg sm:text-2xl font-semibold tracking-tight text-sky-600 truncate">
              {formatMoneyExact(periodCost, cur, hidden)}
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">仅统计按时间计价物品</div>
          </div>

          {/* Net Spent & Recovery */}
          <div className="col-span-1 rounded-xl bg-[#f8fafc] p-3 sm:p-3.5">
            <div className="text-xs text-zinc-500">实际净支出</div>
            <div className="mt-1.5 font-mono text-lg sm:text-2xl font-semibold tracking-tight text-zinc-900 truncate">
              {formatMoney(summary?.net_spent ?? 0, cur, hidden)}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:gap-3 font-mono text-[11px] text-zinc-500">
              <span>投入 {formatMoney(summary?.total_invested ?? 0, cur, hidden)}</span>
              <span className="text-emerald-600">
                回收 {formatMoney(summary?.total_recovered ?? 0, cur, hidden)}
              </span>
            </div>
          </div>

          {/* Controls & Warranty Status */}
          <div className="col-span-2 md:col-span-1 flex flex-col justify-between gap-2.5 rounded-xl bg-[#f8fafc] p-3 sm:p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="yd-segment text-xs">
                {CURRENCIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onUpdateSettings({ display_currency: c })}
                    className={`yd-segment-btn px-2 py-0.5 ${
                      cur === c ? 'yd-segment-active' : 'yd-segment-idle'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <InfoTooltip
                  ariaLabel="查看当前汇率"
                  content={
                    <div className="space-y-1 font-mono text-[11px]">
                      <div className="font-sans font-medium text-zinc-800">
                        当前汇率（{rateSourceText}）
                      </div>
                      <div>1 USD ≈ ¥{usdInCNY}</div>
                      <div>1 EUR ≈ ¥{eurInCNY}</div>
                      {rates?.fetched_at && (
                        <div className="font-sans text-zinc-400">
                          更新：{new Date(rates.fetched_at).toLocaleString('zh-CN')}
                        </div>
                      )}
                    </div>
                  }
                />
                <Tooltip content="刷新汇率">
                  <button
                    type="button"
                    onClick={onRefreshRates}
                    disabled={refreshingRates}
                    className="yd-btn-icon"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${refreshingRates ? 'animate-spin' : ''}`} />
                  </button>
                </Tooltip>
                <Tooltip content={hidden ? '显示金额' : '隐藏金额'}>
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ hide_amounts: !hidden })}
                    className="yd-btn-icon"
                  >
                    {hidden ? <EyeOff className="h-4 w-4 text-sky-600" /> : <Eye className="h-4 w-4" />}
                  </button>
                </Tooltip>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-zinc-600">
                <input
                  type="checkbox"
                  checked={settings.exclude_retired}
                  onChange={(e) => onUpdateSettings({ exclude_retired: e.target.checked })}
                />
                <span>总资产排除退役</span>
              </label>

              <div className="flex items-center gap-1.5">
                {(summary?.warranty_expiring_count ?? 0) > 0 && (
                  <Tooltip content="点击筛选 30 天内过保/到期物品">
                    <button
                      type="button"
                      onClick={() => onFilterWarranty('expiring_soon')}
                      className="yd-badge yd-badge-amber hover:opacity-85"
                    >
                      <AlertTriangle className="h-3 w-3" />
                      临近到期 {summary?.warranty_expiring_count}
                    </button>
                  </Tooltip>
                )}
                {(summary?.warranty_expired_count ?? 0) > 0 && (
                  <Tooltip content="点击筛选已过期物品">
                    <button
                      type="button"
                      onClick={() => onFilterWarranty('expired')}
                      className="yd-badge yd-badge-red hover:opacity-85"
                    >
                      <ShieldAlert className="h-3 w-3" />
                      已过保 {summary?.warranty_expired_count}
                    </button>
                  </Tooltip>
                )}
                {(summary?.warranty_expiring_count ?? 0) === 0 &&
                  (summary?.warranty_expired_count ?? 0) === 0 && (
                    <span className="font-mono text-[11px] text-zinc-400">
                      $≈¥{usdInCNY} · €≈¥{eurInCNY}
                    </span>
                  )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
