import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, FolderInput, PackageOpen, Plus, Trash2 } from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { Select } from '@/components/Select';
import {
  assetsApi,
  buildCategorySelectOptions,
  type AssetItem,
  type AssetItemQuery,
  type AssetSettings,
  type BatchItemInput,
  type RetireItemInput,
  type ViewMode,
} from './api';
import { FilterBar } from './components/FilterBar';
import { FolderBrowserView, ItemCardView, ItemListView } from './components/ItemViews';
import { ItemModal, MetaManagerModal, RetireModal } from './components/ModalsAndDrawers';
import { OverviewBar } from './components/OverviewBar';

const DEFAULT_SETTINGS: AssetSettings = {
  display_currency: 'CNY',
  cost_period: 'daily',
  exclude_retired: false,
  hide_amounts: false,
  default_view: 'card',
};

const EMPTY_QUERY: AssetItemQuery = {
  sort_by: 'manual',
  sort_dir: 'asc',
};

export default function AssetsPage() {
  const qc = useQueryClient();

  const [query, setQuery] = useState<AssetItemQuery>(EMPTY_QUERY);
  const [viewModeOverride, setViewModeOverride] = useState<ViewMode | null>(null);
  const [currentFolder, setCurrentFolder] = useState<number | 'uncategorized' | null>(null);

  // Batch state
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchCategoryTarget, setBatchCategoryTarget] = useState<string>('');
  const [batchRetireOpen, setBatchRetireOpen] = useState(false);

  // Modals (Unified create + edit modal)
  const [modalState, setModalState] = useState<{ open: boolean; itemId: number | null }>({
    open: false,
    itemId: null,
  });
  const [metaManagerOpen, setMetaManagerOpen] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 2500);
  };

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ['assets'] });
  };

  // Queries
  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ['assets', 'meta'],
    queryFn: assetsApi.getMeta,
    staleTime: 60_000,
  });

  const settings = meta?.settings ?? DEFAULT_SETTINGS;
  const viewMode = viewModeOverride ?? settings.default_view;

  // In folder view, fetch without category filter so folder counts & drilldown stay consistent
  const effectiveQuery: AssetItemQuery = useMemo(
    () => ({
      ...query,
      category_id: viewMode === 'folder' ? undefined : query.category_id,
      currency: settings.display_currency,
      exclude_retired: settings.exclude_retired,
    }),
    [query, viewMode, settings.display_currency, settings.exclude_retired],
  );

  const { data: itemsRes, isLoading: itemsLoading } = useQuery({
    queryKey: ['assets', 'items', effectiveQuery],
    queryFn: () => assetsApi.listItems(effectiveQuery),
  });

  // Fetch full unfiltered items lightly for parent selector inside modal when open
  const { data: allItemsRes } = useQuery({
    queryKey: ['assets', 'all-items-ref', settings.display_currency],
    queryFn: () => assetsApi.listItems({ currency: settings.display_currency }),
    enabled: modalState.open,
    staleTime: 30_000,
  });

  const items = itemsRes?.items ?? [];
  const categories = meta?.categories ?? [];
  const tags = meta?.tags ?? [];
  const channels = meta?.channels ?? [];
  const locations = meta?.locations ?? [];
  const rates = itemsRes?.rates ?? meta?.rates;

  const batchCategoryOptions = useMemo(
    () => buildCategorySelectOptions(categories, '归入未分类', false),
    [categories],
  );

  // Mutations
  const updateSettingsMut = useMutation({
    mutationFn: (patch: Partial<AssetSettings>) => assetsApi.updateSettings(patch),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'meta'], (old: typeof meta) =>
        old ? { ...old, settings: res.settings } : old,
      );
      void qc.invalidateQueries({ queryKey: ['assets', 'items'] });
    },
    onError: (err: Error) => showToast(err.message),
  });

  const refreshRatesMut = useMutation({
    mutationFn: () => assetsApi.getRates(true),
    onSuccess: (res) => {
      qc.setQueryData(['assets', 'meta'], (old: typeof meta) =>
        old ? { ...old, rates: res.rates } : old,
      );
      void qc.invalidateQueries({ queryKey: ['assets', 'items'] });
      showToast(
        res.rates.source === 'live'
          ? '已刷新实时汇率'
          : res.rates.source === 'cached'
            ? '当前展示缓存汇率'
            : '外部汇率接口暂不可用，使用参考汇率',
      );
    },
    onError: (err: Error) => showToast(err.message),
  });

  const useItemMut = useMutation({
    mutationFn: (id: number) => assetsApi.useItem(id, { delta: 1 }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets', 'items'] });
    },
    onError: (err: Error) => showToast(err.message),
  });

  const toggleFavoriteMut = useMutation({
    mutationFn: (item: AssetItem) =>
      assetsApi.updateItem(item.id, {
        name: item.name,
        icon: item.icon,
        image_url: item.image_url,
        price: item.price,
        currency: item.currency,
        purchased_at: item.purchased_at,
        pricing_mode: item.pricing_mode,
        status: item.status === 'favorite' ? 'active' : 'favorite',
        parent_id: item.parent_id,
        category_id: item.category_id,
        channel_id: item.channel_id,
        location_id: item.location_id,
        expected_retire_at: item.expected_retire_at ?? '',
        warranty_until: item.warranty_until ?? '',
        usage_count: item.usage_count,
        note: item.note,
        tag_ids: item.tags.map((t) => t.id),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets', 'items'] });
    },
    onError: (err: Error) => showToast(err.message),
  });

  const reorderMut = useMutation({
    mutationFn: (ids: number[]) => assetsApi.reorderItems(ids),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['assets', 'items'] });
    },
    onError: (err: Error) => showToast(err.message),
  });

  const batchMut = useMutation({
    mutationFn: (payload: BatchItemInput) => assetsApi.batchItems(payload),
    onSuccess: (res, vars) => {
      setSelectedIds(new Set());
      setBatchRetireOpen(false);
      invalidateAll();
      const label =
        vars.action === 'delete'
          ? '删除'
          : vars.action === 'retire'
            ? '退役'
            : '修改分类';
      showToast(`已批量${label} ${res.affected} 件物品`);
    },
    onError: (err: Error) => showToast(err.message),
  });

  const handleUpdateSettings = (patch: Partial<AssetSettings>) => {
    updateSettingsMut.mutate(patch);
  };

  const handleChangeView = (mode: ViewMode) => {
    setViewModeOverride(mode);
    if (mode === 'folder') {
      setCurrentFolder(null);
    }
    updateSettingsMut.mutate({ default_view: mode });
  };

  const handleToggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const hasActiveFilters =
    Boolean(query.q) ||
    Boolean(query.category_id) ||
    Boolean(query.status) ||
    Boolean(query.retire_reason) ||
    Boolean(query.min_price) ||
    Boolean(query.max_price) ||
    Boolean(query.min_daily_cost) ||
    Boolean(query.max_daily_cost) ||
    Boolean(query.purchased_from) ||
    Boolean(query.purchased_to) ||
    Boolean(query.min_holding_days) ||
    Boolean(query.max_holding_days) ||
    Boolean(query.min_usage_count) ||
    Boolean(query.max_usage_count) ||
    Boolean(query.warranty_status) ||
    Boolean(query.tag_ids && query.tag_ids.length > 0);

  const canDrag =
    !batchMode && (query.sort_by ?? 'manual') === 'manual' && (query.sort_dir ?? 'asc') === 'asc';

  return (
    <div className="space-y-4 pb-20">
      <OverviewBar
        summary={itemsRes?.summary}
        settings={settings}
        rates={rates}
        refreshingRates={refreshRatesMut.isPending}
        onUpdateSettings={handleUpdateSettings}
        onRefreshRates={() => refreshRatesMut.mutate()}
        onCreateItem={() => setModalState({ open: true, itemId: null })}
        onFilterWarranty={(st) => setQuery((q) => ({ ...q, warranty_status: st }))}
      />

      {toast && <div className="yd-notice">{toast}</div>}

      <FilterBar
        query={query}
        viewMode={viewMode}
        batchMode={batchMode}
        categories={categories}
        tags={tags}
        onChangeQuery={(patch) => setQuery((cur) => ({ ...cur, ...patch }))}
        onResetFilters={() => setQuery(EMPTY_QUERY)}
        onChangeView={handleChangeView}
        onToggleBatchMode={() => {
          setBatchMode((v) => !v);
          setSelectedIds(new Set());
        }}
        onOpenMetaManager={() => setMetaManagerOpen(true)}
      />

      {/* Main Content */}
      {metaLoading || itemsLoading ? (
        <div className="yd-card">
          <LoadingState label="正在加载模块..." variant="section" />
        </div>
      ) : items.length === 0 && viewMode !== 'folder' ? (
        <div className="yd-empty space-y-3 py-14">
          <PackageOpen className="mx-auto h-10 w-10 text-zinc-300" />
          <div className="text-sm font-medium text-zinc-600">
            {hasActiveFilters ? '没有符合当前筛选条件的物品' : '还没有记录任何物品'}
          </div>
          <p className="text-xs text-zinc-400">
            {hasActiveFilters
              ? '试试放宽关键词、分类或高级筛选条件'
              : '点击「新建物品」，仅填名称与价格即可快速保存，或展开更多选项录入完整信息'}
          </p>
          <div className="flex justify-center gap-2 pt-1">
            {hasActiveFilters ? (
              <button
                type="button"
                onClick={() => setQuery(EMPTY_QUERY)}
                className="yd-btn-secondary"
              >
                清除全部筛选
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setModalState({ open: true, itemId: null })}
                className="yd-btn-primary"
              >
                <Plus className="h-3.5 w-3.5" />
                新建物品
              </button>
            )}
          </div>
        </div>
      ) : viewMode === 'folder' ? (
        <FolderBrowserView
          items={items}
          categories={categories}
          currentFolder={currentFolder}
          onEnterFolder={setCurrentFolder}
          currency={settings.display_currency}
          hideAmounts={settings.hide_amounts}
          batchMode={batchMode}
          selectedIds={selectedIds}
          draggable={false}
          onToggleSelect={handleToggleSelect}
          onOpenItem={(id) => setModalState({ open: true, itemId: id })}
          onUseItem={(id) => useItemMut.mutate(id)}
          onToggleFavorite={(it) => toggleFavoriteMut.mutate(it)}
          onReorder={(ids) => reorderMut.mutate(ids)}
        />
      ) : viewMode === 'list' ? (
        <ItemListView
          items={items}
          currency={settings.display_currency}
          hideAmounts={settings.hide_amounts}
          batchMode={batchMode}
          selectedIds={selectedIds}
          draggable={canDrag}
          onToggleSelect={handleToggleSelect}
          onOpenItem={(id) => setModalState({ open: true, itemId: id })}
          onUseItem={(id) => useItemMut.mutate(id)}
          onToggleFavorite={(it) => toggleFavoriteMut.mutate(it)}
          onReorder={(ids) => reorderMut.mutate(ids)}
        />
      ) : (
        <ItemCardView
          items={items}
          currency={settings.display_currency}
          hideAmounts={settings.hide_amounts}
          batchMode={batchMode}
          selectedIds={selectedIds}
          draggable={canDrag}
          onToggleSelect={handleToggleSelect}
          onOpenItem={(id) => setModalState({ open: true, itemId: id })}
          onUseItem={(id) => useItemMut.mutate(id)}
          onToggleFavorite={(it) => toggleFavoriteMut.mutate(it)}
          onReorder={(ids) => reorderMut.mutate(ids)}
        />
      )}

      {/* Floating Batch Action Bar */}
      {batchMode && (
        <div className="fixed right-4 bottom-5 left-4 z-30 mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-200 bg-white/95 px-4 py-3 shadow-xl backdrop-blur">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-zinc-800">
              已选 <strong className="text-sky-600">{selectedIds.size}</strong> 件
            </span>
            <button
              type="button"
              onClick={() =>
                setSelectedIds(
                  selectedIds.size === items.length ? new Set() : new Set(items.map((x) => x.id)),
                )
              }
              className="yd-btn-ghost px-2 py-1 text-xs text-sky-600"
            >
              {selectedIds.size === items.length && items.length > 0 ? '取消全选' : '全选当前'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Select
                value={batchCategoryTarget}
                onChange={setBatchCategoryTarget}
                options={batchCategoryOptions}
                className="min-w-[140px]"
                ariaLabel="选择目标分类"
              />
              <button
                type="button"
                disabled={selectedIds.size === 0 || batchMut.isPending}
                onClick={() =>
                  batchMut.mutate({
                    action: 'set_category',
                    item_ids: Array.from(selectedIds),
                    category_id: batchCategoryTarget ? Number(batchCategoryTarget) : undefined,
                  })
                }
                className="yd-btn-secondary"
              >
                <FolderInput className="h-3.5 w-3.5" />
                改分类
              </button>
            </div>

            <button
              type="button"
              disabled={selectedIds.size === 0 || batchMut.isPending}
              onClick={() => setBatchRetireOpen(true)}
              className="yd-btn-secondary"
            >
              <Archive className="h-3.5 w-3.5" />
              批量退役
            </button>

            <button
              type="button"
              disabled={selectedIds.size === 0 || batchMut.isPending}
              onClick={() => {
                if (window.confirm(`确认批量删除选中的 ${selectedIds.size} 件物品吗？`)) {
                  batchMut.mutate({ action: 'delete', item_ids: Array.from(selectedIds) });
                }
              }}
              className="yd-btn-secondary border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              批量删除
            </button>
          </div>
        </div>
      )}

      {/* Unified Item Modal */}
      <ItemModal
        open={modalState.open}
        itemId={modalState.itemId}
        allItems={allItemsRes?.items ?? items}
        defaultCurrency={settings.display_currency}
        hideAmounts={settings.hide_amounts}
        categories={categories}
        tags={tags}
        channels={channels}
        locations={locations}
        onClose={() => setModalState({ open: false, itemId: null })}
        onSelectItem={(id) => setModalState({ open: true, itemId: id })}
        onMutated={(msg) => {
          invalidateAll();
          if (msg) showToast(msg);
        }}
      />

      <RetireModal
        open={batchRetireOpen}
        title={`批量退役 ${selectedIds.size} 件物品`}
        defaultCurrency={settings.display_currency}
        showSoldPrice={false}
        submitting={batchMut.isPending}
        onClose={() => setBatchRetireOpen(false)}
        onSubmit={(payload: RetireItemInput) =>
          batchMut.mutate({
            action: 'retire',
            item_ids: Array.from(selectedIds),
            retired_at: payload.retired_at,
            retire_reason: payload.retire_reason,
            retire_note: payload.retire_note,
          })
        }
      />

      <MetaManagerModal
        open={metaManagerOpen}
        categories={categories}
        tags={tags}
        channels={channels}
        locations={locations}
        onClose={() => setMetaManagerOpen(false)}
        onChanged={invalidateAll}
      />
    </div>
  );
}
