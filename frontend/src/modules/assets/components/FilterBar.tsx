import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CheckSquare,
  FolderTree,
  History,
  LayoutGrid,
  List,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Select } from '@/components/Select';
import { Tooltip } from '@/components/Tooltip';
import {
  RETIRE_REASON_LABELS,
  SORT_OPTIONS,
  buildCategorySelectOptions,
  type AssetCategory,
  type AssetItemQuery,
  type AssetTag,
  type ItemStatus,
  type RetireReason,
  type SortBy,
  type ViewMode,
  type WarrantyStatus,
} from '../api';

const SEARCH_HISTORY_KEY = 'yukideck_assets_search_history';

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === 'string').slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(list: string[]) {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    // ignore storage errors
  }
}

function getDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const SORT_SELECT_OPTIONS = SORT_OPTIONS.map((o) => ({
  value: o.value,
  label: `排序：${o.label}`,
}));

const RETIRE_REASON_FILTER_OPTIONS = [
  { value: '', label: '全部退役原因' },
  ...(Object.entries(RETIRE_REASON_LABELS) as [RetireReason, string][]).map(([k, label]) => ({
    value: k,
    label,
  })),
];

const WARRANTY_FILTER_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'active', label: '保修中（> 30 天）' },
  { value: 'expiring_soon', label: '30 天内到期' },
  { value: 'expired', label: '已过保 / 已过期' },
  { value: 'none', label: '未设置保修' },
];

interface FilterBarProps {
  query: AssetItemQuery;
  viewMode: ViewMode;
  batchMode: boolean;
  categories: AssetCategory[];
  tags: AssetTag[];
  onChangeQuery: (patch: Partial<AssetItemQuery>) => void;
  onResetFilters: () => void;
  onChangeView: (mode: ViewMode) => void;
  onToggleBatchMode: () => void;
  onOpenMetaManager: () => void;
}

export function FilterBar({
  query,
  viewMode,
  batchMode,
  categories,
  tags,
  onChangeQuery,
  onResetFilters,
  onChangeView,
  onToggleBatchMode,
  onOpenMetaManager,
}: FilterBarProps) {
  const [searchInput, setSearchInput] = useState(query.q ?? '');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(loadSearchHistory);
  const [advOpen, setAdvOpen] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchInput(query.q ?? '');
  }, [query.q]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const categoryOptions = useMemo(
    () => buildCategorySelectOptions(categories, '全部分类', true),
    [categories],
  );

  const commitSearch = (term: string) => {
    const clean = term.trim();
    onChangeQuery({ q: clean || undefined });
    setHistoryOpen(false);
    if (clean) {
      const next = [clean, ...history.filter((h) => h !== clean)].slice(0, 8);
      setHistory(next);
      saveSearchHistory(next);
    }
  };

  const removeHistoryItem = (item: string) => {
    const next = history.filter((h) => h !== item);
    setHistory(next);
    saveSearchHistory(next);
  };

  const clearHistory = () => {
    setHistory([]);
    saveSearchHistory([]);
  };

  const activeAdvancedCount = [
    query.min_price,
    query.max_price,
    query.min_daily_cost,
    query.max_daily_cost,
    query.purchased_from,
    query.purchased_to,
    query.min_holding_days,
    query.max_holding_days,
    query.min_usage_count,
    query.max_usage_count,
    query.warranty_status,
    query.tag_ids && query.tag_ids.length > 0 ? 'tags' : '',
  ].filter(Boolean).length;

  const hasAnyFilter =
    Boolean(query.q) ||
    Boolean(query.category_id) ||
    Boolean(query.status) ||
    Boolean(query.retire_reason) ||
    activeAdvancedCount > 0;

  const toggleTag = (id: number) => {
    const cur = query.tag_ids ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onChangeQuery({ tag_ids: next });
  };

  return (
    <div className="yd-card space-y-3 p-3.5">
      {/* Row 1: Search + Sort + View Mode + Actions */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search box with history */}
        <div ref={searchWrapRef} className="relative w-full sm:w-auto sm:min-w-[200px] sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={searchInput}
            onFocus={() => setHistoryOpen(true)}
            onChange={(e) => {
              setSearchInput(e.target.value);
              if (!e.target.value.trim() && query.q) {
                onChangeQuery({ q: undefined });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitSearch(searchInput);
              }
            }}
            placeholder="搜索名称、备注、渠道、位置或标签（回车搜索）"
            className="yd-input-sm w-full pr-7 pl-8"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                onChangeQuery({ q: undefined });
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}

          {historyOpen && history.length > 0 && (
            <div className="absolute top-full right-0 left-0 z-20 mt-1 rounded-xl border border-zinc-200/90 bg-white p-2 shadow-lg">
              <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-zinc-400">
                <span className="inline-flex items-center gap-1">
                  <History className="h-3 w-3" />
                  搜索历史
                </span>
                <button type="button" onClick={clearHistory} className="hover:text-zinc-600">
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {history.map((h) => (
                  <span
                    key={h}
                    className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 hover:bg-sky-50 hover:text-sky-700"
                  >
                    <button type="button" onClick={() => commitSearch(h)}>
                      {h}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeHistoryItem(h)}
                      className="text-zinc-400 hover:text-zinc-700"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sort controls */}
        <div className="flex items-center gap-1">
          <Select
            value={query.sort_by ?? 'manual'}
            onChange={(v) => onChangeQuery({ sort_by: v as SortBy })}
            options={SORT_SELECT_OPTIONS}
            searchable={false}
            className="min-w-[148px]"
            ariaLabel="排序维度"
          />
          <Tooltip
            content={
              (query.sort_dir ?? 'asc') === 'asc'
                ? '当前升序，点击切换降序'
                : '当前降序，点击切换升序'
            }
          >
            <button
              type="button"
              onClick={() =>
                onChangeQuery({ sort_dir: (query.sort_dir ?? 'asc') === 'asc' ? 'desc' : 'asc' })
              }
              className="yd-btn-secondary px-2"
            >
              {(query.sort_dir ?? 'asc') === 'asc' ? (
                <ArrowUpNarrowWide className="h-4 w-4" />
              ) : (
                <ArrowDownWideNarrow className="h-4 w-4" />
              )}
            </button>
          </Tooltip>
        </div>

        {/* View switcher */}
        <div className="yd-segment-scroll text-xs">
          <button
            type="button"
            onClick={() => onChangeView('card')}
            className={`yd-segment-btn inline-flex items-center gap-1 ${
              viewMode === 'card' ? 'yd-segment-active' : 'yd-segment-idle'
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            卡片
          </button>
          <button
            type="button"
            onClick={() => onChangeView('list')}
            className={`yd-segment-btn inline-flex items-center gap-1 ${
              viewMode === 'list' ? 'yd-segment-active' : 'yd-segment-idle'
            }`}
          >
            <List className="h-3.5 w-3.5" />
            列表
          </button>
          <button
            type="button"
            onClick={() => onChangeView('folder')}
            className={`yd-segment-btn inline-flex items-center gap-1 ${
              viewMode === 'folder' ? 'yd-segment-active' : 'yd-segment-idle'
            }`}
          >
            <FolderTree className="h-3.5 w-3.5" />
            文件夹
          </button>
        </div>

        {/* Advanced filter / Batch / Metadata manager */}
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          className={
            advOpen || activeAdvancedCount > 0
              ? 'yd-btn-secondary border-sky-300 text-sky-700'
              : 'yd-btn-secondary'
          }
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          高级筛选
          {activeAdvancedCount > 0 && (
            <span className="rounded-full bg-sky-500 px-1.5 text-[10px] text-white">
              {activeAdvancedCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={onToggleBatchMode}
          className={batchMode ? 'yd-btn-primary py-1.5' : 'yd-btn-secondary'}
        >
          <CheckSquare className="h-3.5 w-3.5" />
          {batchMode ? '退出批量' : '批量管理'}
        </button>

        <button type="button" onClick={onOpenMetaManager} className="yd-btn-secondary">
          <Settings2 className="h-3.5 w-3.5" />
          分类与属性
        </button>
      </div>

      {/* Row 2: Quick Filters (Category + Status + Retire Reason) */}
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2.5">
        {viewMode !== 'folder' && (
          <Select
            value={query.category_id === undefined ? '' : String(query.category_id)}
            onChange={(v) => {
              if (v === '') onChangeQuery({ category_id: '' });
              else if (v === 'uncategorized') onChangeQuery({ category_id: 'uncategorized' });
              else onChangeQuery({ category_id: Number(v) });
            }}
            options={categoryOptions}
            className="min-w-[140px] max-w-[200px]"
            ariaLabel="按分类筛选"
          />
        )}

        <div className="yd-segment-scroll text-xs">
          {(
            [
              ['', '全部状态'],
              ['active', '服役中'],
              ['favorite', '收藏'],
              ['retired', '已退役'],
            ] as [ItemStatus | '', string][]
          ).map(([val, label]) => (
            <button
              key={val || 'all'}
              type="button"
              onClick={() =>
                onChangeQuery({
                  status: val,
                  retire_reason: val === 'retired' ? query.retire_reason : '',
                })
              }
              className={`yd-segment-btn ${
                (query.status ?? '') === val ? 'yd-segment-active' : 'yd-segment-idle'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {query.status === 'retired' && (
          <Select
            value={query.retire_reason ?? ''}
            onChange={(v) => onChangeQuery({ retire_reason: v as RetireReason | '' })}
            options={RETIRE_REASON_FILTER_OPTIONS}
            searchable={false}
            className="min-w-[130px]"
            ariaLabel="按退役原因筛选"
          />
        )}

        {hasAnyFilter && (
          <button
            type="button"
            onClick={() => {
              setSearchInput('');
              onResetFilters();
            }}
            className="yd-btn-ghost ml-auto text-xs text-sky-600 hover:text-sky-700"
          >
            <X className="h-3.5 w-3.5" />
            清除全部筛选
          </button>
        )}
      </div>

      {/* Expandable Advanced Filters */}
      {advOpen && (
        <div className="yd-panel-subtle space-y-3 p-3.5 text-xs">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {/* Price range */}
            <div className="space-y-1">
              <div className="font-medium text-zinc-600">价格区间（当前币种）</div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={query.min_price ?? ''}
                  onChange={(e) => onChangeQuery({ min_price: e.target.value })}
                  placeholder="最低价"
                  className="yd-input-sm min-w-0 flex-1"
                />
                <span className="text-zinc-400">~</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={query.max_price ?? ''}
                  onChange={(e) => onChangeQuery({ max_price: e.target.value })}
                  placeholder="最高价"
                  className="yd-input-sm min-w-0 flex-1"
                />
              </div>
            </div>

            {/* Daily cost range */}
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-1.5 sm:gap-2">
                <span className="font-medium text-zinc-600">日均价格区间</span>
                <div className="flex gap-1 text-[11px]">
                  {[
                    ['<1', '', '1'],
                    ['1-5', '1', '5'],
                    ['5-20', '5', '20'],
                    ['>20', '20', ''],
                  ].map(([label, min, max]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onChangeQuery({ min_daily_cost: min, max_daily_cost: max })}
                      className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={query.min_daily_cost ?? ''}
                  onChange={(e) => onChangeQuery({ min_daily_cost: e.target.value })}
                  placeholder="最低日均"
                  className="yd-input-sm min-w-0 flex-1"
                />
                <span className="text-zinc-400">~</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={query.max_daily_cost ?? ''}
                  onChange={(e) => onChangeQuery({ max_daily_cost: e.target.value })}
                  placeholder="最高日均"
                  className="yd-input-sm min-w-0 flex-1"
                />
              </div>
            </div>

            {/* Purchase date range */}
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-1.5 sm:gap-2">
                <span className="font-medium text-zinc-600">购买日期区间</span>
                <div className="flex gap-1 text-[11px]">
                  {[
                    ['30天', 30],
                    ['3月', 90],
                    ['6月', 180],
                    ['1年', 365],
                  ].map(([label, days]) => (
                    <button
                      key={label as string}
                      type="button"
                      onClick={() =>
                        onChangeQuery({
                          purchased_from: getDateOffset(days as number),
                          purchased_to: '',
                        })
                      }
                      className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900"
                    >
                      近{label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={query.purchased_from ?? ''}
                  onChange={(e) => onChangeQuery({ purchased_from: e.target.value })}
                  className="yd-input-sm min-w-0 flex-1"
                />
                <span className="text-zinc-400">~</span>
                <input
                  type="date"
                  value={query.purchased_to ?? ''}
                  onChange={(e) => onChangeQuery({ purchased_to: e.target.value })}
                  className="yd-input-sm min-w-0 flex-1"
                />
              </div>
            </div>

            {/* Holding days */}
            <div className="space-y-1">
              <div className="font-medium text-zinc-600">持有天数</div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  value={query.min_holding_days ?? ''}
                  onChange={(e) => onChangeQuery({ min_holding_days: e.target.value })}
                  placeholder="最少天数"
                  className="yd-input-sm min-w-0 flex-1"
                />
                <span className="text-zinc-400">~</span>
                <input
                  type="number"
                  min={0}
                  value={query.max_holding_days ?? ''}
                  onChange={(e) => onChangeQuery({ max_holding_days: e.target.value })}
                  placeholder="最多天数"
                  className="yd-input-sm min-w-0 flex-1"
                />
              </div>
            </div>

            {/* Usage count */}
            <div className="space-y-1">
              <div className="font-medium text-zinc-600">使用次数</div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  value={query.min_usage_count ?? ''}
                  onChange={(e) => onChangeQuery({ min_usage_count: e.target.value })}
                  placeholder="最少次数"
                  className="yd-input-sm min-w-0 flex-1"
                />
                <span className="text-zinc-400">~</span>
                <input
                  type="number"
                  min={0}
                  value={query.max_usage_count ?? ''}
                  onChange={(e) => onChangeQuery({ max_usage_count: e.target.value })}
                  placeholder="最多次数"
                  className="yd-input-sm min-w-0 flex-1"
                />
              </div>
            </div>

            {/* Warranty status */}
            <div className="space-y-1">
              <div className="font-medium text-zinc-600">保修 / 保质期状态</div>
              <Select
                value={query.warranty_status ?? ''}
                onChange={(v) => onChangeQuery({ warranty_status: v as WarrantyStatus | '' })}
                options={WARRANTY_FILTER_OPTIONS}
                searchable={false}
                className="w-full"
                ariaLabel="保修状态筛选"
              />
            </div>
          </div>

          {/* Multi-select tags */}
          {tags.length > 0 && (
            <div className="space-y-1.5 border-t border-zinc-200/70 pt-2.5">
              <div className="flex items-center justify-between">
                <span className="font-medium text-zinc-600">标签筛选</span>
                <div className="yd-segment text-[11px]">
                  <button
                    type="button"
                    onClick={() => onChangeQuery({ tag_mode: 'any' })}
                    className={`yd-segment-btn px-2 py-0.5 ${
                      (query.tag_mode ?? 'any') === 'any' ? 'yd-segment-active' : 'yd-segment-idle'
                    }`}
                  >
                    满足任一
                  </button>
                  <button
                    type="button"
                    onClick={() => onChangeQuery({ tag_mode: 'all' })}
                    className={`yd-segment-btn px-2 py-0.5 ${
                      query.tag_mode === 'all' ? 'yd-segment-active' : 'yd-segment-idle'
                    }`}
                  >
                    同时满足
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const selected = (query.tag_ids ?? []).includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`yd-badge transition-colors ${
                        selected
                          ? 'bg-sky-500 text-white'
                          : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:ring-sky-300'
                      }`}
                    >
                      {tag.color && !selected && (
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                      )}
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
