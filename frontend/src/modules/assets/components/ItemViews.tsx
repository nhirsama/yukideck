import { useState } from 'react';
import {
  ChevronRight,
  Folder,
  GripVertical,
  Home,
  Layers,
  Plus,
  Star,
} from 'lucide-react';
import { Tooltip } from '@/components/Tooltip';
import {
  RETIRE_REASON_LABELS,
  formatMoney,
  formatMoneyExact,
  formatWarrantyLabel,
  type AssetCategory,
  type AssetItem,
  type Currency,
  type RetireReason,
} from '../api';
import { AssetIcon, AssetVisual } from './IconPicker';

interface CommonViewProps {
  items: AssetItem[];
  currency: Currency;
  hideAmounts: boolean;
  batchMode: boolean;
  selectedIds: Set<number>;
  draggable: boolean;
  onToggleSelect: (id: number) => void;
  onOpenItem: (id: number) => void;
  onUseItem: (id: number) => void;
  onToggleFavorite: (item: AssetItem) => void;
  onReorder: (orderedIds: number[]) => void;
}

function StatusBadge({ item }: { item: AssetItem }) {
  if (item.status === 'retired') {
    const reason = item.retire_reason
      ? RETIRE_REASON_LABELS[item.retire_reason as RetireReason]
      : '';
    return (
      <span className="yd-badge yd-badge-neutral">
        已退役{reason ? ` · ${reason}` : ''}
      </span>
    );
  }
  if (item.status === 'favorite') {
    return <span className="yd-badge yd-badge-amber">收藏</span>;
  }
  return <span className="yd-badge yd-badge-emerald">服役中</span>;
}

function WarrantyBadge({ item }: { item: AssetItem }) {
  const info = formatWarrantyLabel(item.warranty_status, item.warranty_days_left);
  if (!info) return null;
  const cls =
    info.tone === 'red'
      ? 'yd-badge-red'
      : info.tone === 'amber'
        ? 'yd-badge-amber'
        : 'yd-badge-emerald';
  return <span className={`yd-badge ${cls}`}>{info.text}</span>;
}

function CostTag({
  item,
  currency,
  hideAmounts,
}: {
  item: AssetItem;
  currency: Currency;
  hideAmounts: boolean;
}) {
  if (item.pricing_mode === 'time' && item.daily_cost !== undefined) {
    return (
      <span className="font-mono text-xs font-medium text-sky-600">
        {formatMoneyExact(item.daily_cost, currency, hideAmounts)}/天
      </span>
    );
  }
  if (item.pricing_mode === 'usage' && item.usage_cost !== undefined) {
    return (
      <span className="font-mono text-xs font-medium text-violet-600">
        {formatMoneyExact(item.usage_cost, currency, hideAmounts)}/次
      </span>
    );
  }
  return <span className="text-xs text-zinc-400">不计价</span>;
}

function reorderList(items: AssetItem[], fromId: number, toId: number): number[] | null {
  if (fromId === toId) return null;
  const ids = items.map((x) => x.id);
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return null;
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, fromId);
  return ids;
}

// --- 1. Card Grid View ---

export function ItemCardView({
  items,
  currency,
  hideAmounts,
  batchMode,
  selectedIds,
  draggable,
  onToggleSelect,
  onOpenItem,
  onUseItem,
  onToggleFavorite,
  onReorder,
}: CommonViewProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        const selected = selectedIds.has(item.id);
        const isOver = overId === item.id && dragId !== item.id;
        return (
          <div
            key={item.id}
            draggable={draggable}
            onDragStart={() => setDragId(item.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDragOver={(e) => {
              if (!draggable) return;
              e.preventDefault();
              if (overId !== item.id) setOverId(item.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (!draggable || dragId == null) return;
              const next = reorderList(items, dragId, item.id);
              setDragId(null);
              setOverId(null);
              if (next) onReorder(next);
            }}
            onClick={() => (batchMode ? onToggleSelect(item.id) : onOpenItem(item.id))}
            className={`yd-card-interactive relative flex cursor-pointer flex-col justify-between gap-3 p-4 ${
              item.status === 'retired' ? 'opacity-75' : ''
            } ${selected ? 'border-sky-400 bg-sky-50/30 ring-1 ring-sky-300' : ''} ${
              isOver ? 'border-sky-400 ring-2 ring-sky-200' : ''
            }`}
          >
            {/* Top Row */}
            <div className="flex items-start gap-3">
              {batchMode && (
                <div className="pt-1" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleSelect(item.id)}
                  />
                </div>
              )}
              {draggable && (
                <Tooltip content="拖拽调整顺序">
                  <div
                    className="cursor-grab pt-2.5 text-zinc-300 hover:text-zinc-500 active:cursor-grabbing"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GripVertical className="h-4 w-4" />
                  </div>
                </Tooltip>
              )}
              <AssetVisual icon={item.icon} imageUrl={item.image_url} name={item.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-[15px] font-semibold text-zinc-800">{item.name}</h3>
                  {!batchMode && item.status !== 'retired' && (
                    <Tooltip content={item.status === 'favorite' ? '取消收藏' : '设为收藏'}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFavorite(item);
                        }}
                        className="shrink-0 rounded p-0.5 text-zinc-300 transition-colors hover:text-amber-500"
                      >
                        <Star
                          className={`h-4 w-4 ${
                            item.status === 'favorite' ? 'fill-amber-400 text-amber-400' : ''
                          }`}
                        />
                      </button>
                    </Tooltip>
                  )}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                  {item.category_name && (
                    <span className="truncate max-w-[160px]">{item.category_name}</span>
                  )}
                  {item.parent_name && (
                    <span className="yd-badge yd-badge-sky text-[11px]">
                      隶属：{item.parent_name}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Price & Cost Row */}
            <div className="flex items-end justify-between gap-2 rounded-lg bg-[#f8fafc] px-3 py-2">
              <div>
                <div className="font-mono text-base font-semibold text-zinc-900">
                  {formatMoney(item.total_invested, currency, hideAmounts)}
                </div>
                {item.currency !== currency && (
                  <div className="font-mono text-[11px] text-zinc-400">
                    原价 {formatMoney(item.price, item.currency, hideAmounts)}
                  </div>
                )}
              </div>
              <div className="text-right">
                <CostTag item={item} currency={currency} hideAmounts={hideAmounts} />
                <div className="mt-0.5 text-[11px] text-zinc-400">
                  持有 {item.holding_days} 天
                </div>
              </div>
            </div>

            {/* Badges & Quick Footer */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge item={item} />
                <WarrantyBadge item={item} />
                {item.children_count > 0 && (
                  <span className="yd-badge yd-badge-sky">
                    <Layers className="h-3 w-3" />
                    {item.children_count} 件子物品
                  </span>
                )}
                {item.tags.slice(0, 2).map((tag) => (
                  <span key={tag.id} className="yd-badge yd-badge-neutral">
                    {tag.color && (
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                    )}
                    {tag.name}
                  </span>
                ))}
                {item.tags.length > 2 && (
                  <span className="text-[11px] text-zinc-400">+{item.tags.length - 2}</span>
                )}
              </div>

              {!batchMode && (
                <Tooltip content="记录使用次数 +1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUseItem(item.id);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-white px-2 py-0.5 font-mono text-xs text-zinc-600 transition-colors hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
                  >
                    <Plus className="h-3 w-3" />
                    {item.usage_count}次
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- 2. Compact List View ---

export function ItemListView({
  items,
  currency,
  hideAmounts,
  batchMode,
  selectedIds,
  draggable,
  onToggleSelect,
  onOpenItem,
  onUseItem,
  onToggleFavorite,
  onReorder,
}: CommonViewProps) {
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

  return (
    <div className="yd-card overflow-x-auto">
      <table className="yd-table">
        <thead className="yd-thead">
          <tr>
            {(batchMode || draggable) && <th className="w-10 px-3 py-2.5" />}
            <th className="px-3 py-2.5">物品</th>
            <th className="px-3 py-2.5">分类 / 标签</th>
            <th className="px-3 py-2.5 text-right">总投入</th>
            <th className="px-3 py-2.5 text-right">均价 / 持有</th>
            <th className="px-3 py-2.5">状态 / 保修</th>
            <th className="px-3 py-2.5 text-right">使用次数</th>
          </tr>
        </thead>
        <tbody className="yd-tbody">
          {items.map((item) => {
            const selected = selectedIds.has(item.id);
            const isOver = overId === item.id && dragId !== item.id;
            return (
              <tr
                key={item.id}
                draggable={draggable}
                onDragStart={() => setDragId(item.id)}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  if (!draggable) return;
                  e.preventDefault();
                  if (overId !== item.id) setOverId(item.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!draggable || dragId == null) return;
                  const next = reorderList(items, dragId, item.id);
                  setDragId(null);
                  setOverId(null);
                  if (next) onReorder(next);
                }}
                onClick={() => (batchMode ? onToggleSelect(item.id) : onOpenItem(item.id))}
                className={`cursor-pointer transition-colors hover:bg-sky-50/40 ${
                  item.status === 'retired' ? 'opacity-70' : ''
                } ${selected ? 'bg-sky-50/60' : ''} ${isOver ? 'bg-sky-100/60' : ''}`}
              >
                {(batchMode || draggable) && (
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {batchMode ? (
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => onToggleSelect(item.id)}
                      />
                    ) : (
                      <GripVertical className="h-4 w-4 cursor-grab text-zinc-300 hover:text-zinc-500" />
                    )}
                  </td>
                )}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <AssetVisual
                      icon={item.icon}
                      imageUrl={item.image_url}
                      name={item.name}
                      size="sm"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-zinc-800">{item.name}</span>
                        {!batchMode && item.status !== 'retired' && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleFavorite(item);
                            }}
                            className="text-zinc-300 hover:text-amber-500"
                          >
                            <Star
                              className={`h-3.5 w-3.5 ${
                                item.status === 'favorite' ? 'fill-amber-400 text-amber-400' : ''
                              }`}
                            />
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                        <span>{item.purchased_at}</span>
                        {item.parent_name && <span>· 隶属 {item.parent_name}</span>}
                        {item.children_count > 0 && (
                          <span className="text-sky-600">· {item.children_count} 子物品</span>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="text-xs text-zinc-600">{item.category_name || '未分类'}</div>
                  {item.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {item.tags.slice(0, 3).map((t) => (
                        <span key={t.id} className="yd-badge yd-badge-neutral text-[11px]">
                          {t.name}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right font-mono">
                  <div className="font-medium text-zinc-800">
                    {formatMoney(item.total_invested, currency, hideAmounts)}
                  </div>
                  {item.currency !== currency && (
                    <div className="text-[11px] text-zinc-400">
                      {formatMoney(item.price, item.currency, hideAmounts)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div>
                    <CostTag item={item} currency={currency} hideAmounts={hideAmounts} />
                  </div>
                  <div className="text-[11px] text-zinc-400">{item.holding_days} 天</div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge item={item} />
                    <WarrantyBadge item={item} />
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => onUseItem(item.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-200/80 bg-white px-2 py-0.5 font-mono text-xs text-zinc-600 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
                  >
                    <Plus className="h-3 w-3" />
                    {item.usage_count}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- 3. Two-Level Folder Browser View ---

interface FolderBrowserViewProps extends CommonViewProps {
  categories: AssetCategory[];
  currentFolder: number | 'uncategorized' | null;
  onEnterFolder: (folder: number | 'uncategorized' | null) => void;
}

export function FolderBrowserView({
  items,
  categories,
  currentFolder,
  onEnterFolder,
  currency,
  hideAmounts,
  batchMode,
  selectedIds,
  onToggleSelect,
  onOpenItem,
  onUseItem,
  onToggleFavorite,
  onReorder,
}: FolderBrowserViewProps) {
  const catById = new Map(categories.map((c) => [c.id, c]));
  const topCats = categories.filter((c) => !c.parent_id);
  const subCatsByParent = new Map<number, AssetCategory[]>();
  for (const c of categories) {
    if (c.parent_id) {
      const list = subCatsByParent.get(c.parent_id) ?? [];
      list.push(c);
      subCatsByParent.set(c.parent_id, list);
    }
  }

  // Stats per category (level-1 rolls up its own + level-2 children)
  const calcFolderStats = (catId: number) => {
    const subs = subCatsByParent.get(catId) ?? [];
    const allowed = new Set<number>([catId, ...subs.map((s) => s.id)]);
    let count = 0;
    let total = 0;
    for (const it of items) {
      if (it.category_id && allowed.has(it.category_id)) {
        count++;
        total += it.total_invested;
      }
    }
    return { count, total };
  };

  const uncategorizedItems = items.filter((it) => !it.category_id);
  const uncategorizedTotal = uncategorizedItems.reduce((sum, it) => sum + it.total_invested, 0);

  // Build breadcrumbs
  const activeCat = typeof currentFolder === 'number' ? catById.get(currentFolder) : undefined;
  const activeParentCat = activeCat?.parent_id ? catById.get(activeCat.parent_id) : undefined;

  // Determine sub-folders and items visible at current drilldown level
  let foldersToShow: {
    id: number | 'uncategorized';
    name: string;
    icon: string;
    count: number;
    total: number;
  }[] = [];
  let visibleItems: AssetItem[] = [];

  if (currentFolder === null) {
    foldersToShow = topCats.map((c) => {
      const st = calcFolderStats(c.id);
      return { id: c.id, name: c.name, icon: c.icon, count: st.count, total: st.total };
    });
    if (uncategorizedItems.length > 0 || foldersToShow.length === 0) {
      foldersToShow.push({
        id: 'uncategorized',
        name: '未分类',
        icon: 'folder',
        count: uncategorizedItems.length,
        total: uncategorizedTotal,
      });
    }
  } else if (currentFolder === 'uncategorized') {
    visibleItems = uncategorizedItems;
  } else if (activeCat && !activeCat.parent_id) {
    // Level-1 folder: show level-2 sub-folders + items directly assigned to this level-1 category
    const subs = subCatsByParent.get(activeCat.id) ?? [];
    foldersToShow = subs.map((sc) => {
      const st = calcFolderStats(sc.id);
      return { id: sc.id, name: sc.name, icon: sc.icon, count: st.count, total: st.total };
    });
    visibleItems = items.filter((it) => it.category_id === activeCat.id);
  } else if (activeCat) {
    // Level-2 folder
    visibleItems = items.filter((it) => it.category_id === activeCat.id);
  }

  return (
    <div className="space-y-4">
      {/* Breadcrumb bar */}
      <div className="yd-card flex flex-wrap items-center gap-1.5 px-3.5 py-2.5 text-sm">
        <button
          type="button"
          onClick={() => onEnterFolder(null)}
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors ${
            currentFolder === null
              ? 'bg-sky-50 font-medium text-sky-700'
              : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
          }`}
        >
          <Home className="h-3.5 w-3.5" />
          全部分类
        </button>

        {currentFolder === 'uncategorized' && (
          <>
            <ChevronRight className="h-4 w-4 text-zinc-300" />
            <span className="rounded-md bg-sky-50 px-2 py-1 font-medium text-sky-700">未分类</span>
          </>
        )}

        {activeParentCat && (
          <>
            <ChevronRight className="h-4 w-4 text-zinc-300" />
            <button
              type="button"
              onClick={() => onEnterFolder(activeParentCat.id)}
              className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
            >
              {activeParentCat.name}
            </button>
          </>
        )}

        {activeCat && (
          <>
            <ChevronRight className="h-4 w-4 text-zinc-300" />
            <span className="rounded-md bg-sky-50 px-2 py-1 font-medium text-sky-700">
              {activeCat.name}
            </span>
          </>
        )}
      </div>

      {/* Sub-folder grid */}
      {foldersToShow.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {foldersToShow.map((f) => (
            <button
              key={String(f.id)}
              type="button"
              onClick={() => onEnterFolder(f.id)}
              className="yd-card-interactive flex items-center gap-3 p-3.5 text-left"
            >
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                  f.id === 'uncategorized'
                    ? 'bg-zinc-100 text-zinc-500'
                    : 'bg-sky-50 text-sky-600'
                }`}
              >
                {f.id === 'uncategorized' ? (
                  <Folder className="h-5 w-5" />
                ) : (
                  <AssetIcon name={f.icon} className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-zinc-800">{f.name}</div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-zinc-400">
                  <span>{f.count} 件</span>
                  <span className="font-mono text-zinc-600">
                    {formatMoney(f.total, currency, hideAmounts)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Items directly in current folder */}
      {visibleItems.length > 0 && (
        <div className="space-y-2">
          {foldersToShow.length > 0 && (
            <div className="text-xs font-medium text-zinc-400">当前目录下物品</div>
          )}
          <ItemCardView
            items={visibleItems}
            currency={currency}
            hideAmounts={hideAmounts}
            batchMode={batchMode}
            selectedIds={selectedIds}
            draggable={false}
            onToggleSelect={onToggleSelect}
            onOpenItem={onOpenItem}
            onUseItem={onUseItem}
            onToggleFavorite={onToggleFavorite}
            onReorder={onReorder}
          />
        </div>
      )}

      {currentFolder !== null && foldersToShow.length === 0 && visibleItems.length === 0 && (
        <div className="yd-empty py-12 text-sm">该分类下暂无符合条件的物品</div>
      )}
    </div>
  );
}
