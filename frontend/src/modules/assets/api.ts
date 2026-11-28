import { request } from '@/core/api';
import { formatDateISOInTimezone, getActiveUserTimezone } from '@/core/timezone';
import type {
  BatchItemInput,
  CategoryView,
  ChannelView,
  ExchangeRatesView,
  ItemDetailResponse,
  ItemRef,
  ItemView,
  ListItemsResponse,
  LocationView,
  MetaResponse,
  ReorderInput,
  RetireItemInput,
  SummaryView,
  TagView,
  TransactionView,
  UpdateSettingsInput,
  UpsertCategoryInput,
  UpsertChannelInput,
  UpsertItemInput,
  UpsertLocationInput,
  UpsertTagInput,
  UpsertTransactionInput,
  UseItemInput,
  UserSettings,
} from './api.gen';

export type Currency = UserSettings['display_currency'];
export type CostPeriod = UserSettings['cost_period'];
export type ViewMode = UserSettings['default_view'];
export type PricingMode = ItemView['pricing_mode'];
export type ItemStatus = ItemView['status'];
export type RetireReason = RetireItemInput['retire_reason'];
export type WarrantyStatus = ItemView['warranty_status'];
export type SortBy =
  | 'manual'
  | 'created_at'
  | 'updated_at'
  | 'price'
  | 'daily_cost'
  | 'usage_count'
  | 'holding_days'
  | 'expected_retire_at'
  | 'warranty_until'
  | 'status_priority';

export type {
  BatchItemInput,
  CategoryView as AssetCategory,
  ChannelView as AssetChannel,
  ExchangeRatesView as AssetRates,
  ItemDetailResponse as AssetItemDetail,
  ItemRef as AssetItemRef,
  ItemView as AssetItem,
  ListItemsResponse as AssetItemsResponse,
  LocationView as AssetLocation,
  MetaResponse as AssetMeta,
  RetireItemInput,
  SummaryView as AssetSummary,
  TagView as AssetTag,
  TransactionView as AssetTransaction,
  UpdateSettingsInput,
  UpsertCategoryInput,
  UpsertChannelInput,
  UpsertItemInput,
  UpsertLocationInput,
  UpsertTagInput,
  UpsertTransactionInput,
  UserSettings as AssetSettings,
};

export interface AssetItemQuery {
  today?: string;
  currency?: Currency;
  exclude_retired?: boolean;
  q?: string;
  category_id?: number | 'uncategorized' | '';
  exact_category?: boolean;
  status?: ItemStatus | '';
  retire_reason?: RetireReason | '';
  min_price?: string;
  max_price?: string;
  min_daily_cost?: string;
  max_daily_cost?: string;
  purchased_from?: string;
  purchased_to?: string;
  min_holding_days?: string;
  max_holding_days?: string;
  min_usage_count?: string;
  max_usage_count?: string;
  warranty_status?: WarrantyStatus | '';
  tag_ids?: number[];
  tag_mode?: 'any' | 'all';
  sort_by?: SortBy;
  sort_dir?: 'asc' | 'desc';
}

export function getLocalTodayString(tz = getActiveUserTimezone()): string {
  return formatDateISOInTimezone(new Date(), tz);
}

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') {
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const assetsApi = {
  getMeta: () => request<MetaResponse>('/api/v1/assets/meta'),
  updateSettings: (payload: UpdateSettingsInput) =>
    request<{ settings: UserSettings }>('/api/v1/assets/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getRates: (refresh = false) =>
    request<{ rates: ExchangeRatesView }>(`/api/v1/assets/rates${refresh ? '?refresh=true' : ''}`),

  // Categories
  createCategory: (payload: UpsertCategoryInput) =>
    request<{ category: CategoryView }>('/api/v1/assets/categories', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCategory: (id: number, payload: UpsertCategoryInput) =>
    request<{ category: CategoryView }>(`/api/v1/assets/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteCategory: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/assets/categories/${id}`, { method: 'DELETE' }),
  reorderCategories: (payload: ReorderInput) =>
    request<{ ok: boolean }>('/api/v1/assets/categories/reorder', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Tags
  createTag: (payload: UpsertTagInput) =>
    request<{ tag: TagView }>('/api/v1/assets/tags', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateTag: (id: number, payload: UpsertTagInput) =>
    request<{ tag: TagView }>(`/api/v1/assets/tags/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteTag: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/assets/tags/${id}`, { method: 'DELETE' }),

  // Channels
  createChannel: (payload: UpsertChannelInput) =>
    request<{ channel: ChannelView }>('/api/v1/assets/channels', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateChannel: (id: number, payload: UpsertChannelInput) =>
    request<{ channel: ChannelView }>(`/api/v1/assets/channels/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteChannel: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/assets/channels/${id}`, { method: 'DELETE' }),

  // Locations
  createLocation: (payload: UpsertLocationInput) =>
    request<{ location: LocationView }>('/api/v1/assets/locations', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateLocation: (id: number, payload: UpsertLocationInput) =>
    request<{ location: LocationView }>(`/api/v1/assets/locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteLocation: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/assets/locations/${id}`, { method: 'DELETE' }),

  // Items
  listItems: (q: AssetItemQuery) => {
    const qs = buildQueryString({
      today: q.today ?? getLocalTodayString(),
      currency: q.currency,
      exclude_retired: q.exclude_retired,
      q: q.q?.trim(),
      category_id: q.category_id === '' ? undefined : q.category_id,
      exact_category: q.exact_category ? true : undefined,
      status: q.status || undefined,
      retire_reason: q.retire_reason || undefined,
      min_price: q.min_price?.trim(),
      max_price: q.max_price?.trim(),
      min_daily_cost: q.min_daily_cost?.trim(),
      max_daily_cost: q.max_daily_cost?.trim(),
      purchased_from: q.purchased_from?.trim(),
      purchased_to: q.purchased_to?.trim(),
      min_holding_days: q.min_holding_days?.trim(),
      max_holding_days: q.max_holding_days?.trim(),
      min_usage_count: q.min_usage_count?.trim(),
      max_usage_count: q.max_usage_count?.trim(),
      warranty_status: q.warranty_status || undefined,
      tag_ids: q.tag_ids && q.tag_ids.length > 0 ? q.tag_ids.join(',') : undefined,
      tag_mode: q.tag_ids && q.tag_ids.length > 0 ? q.tag_mode : undefined,
      sort_by: q.sort_by,
      sort_dir: q.sort_dir,
    });
    return request<ListItemsResponse>(`/api/v1/assets/items${qs}`);
  },
  getItemDetail: (id: number, currency?: Currency) => {
    const qs = buildQueryString({ today: getLocalTodayString(), currency });
    return request<ItemDetailResponse>(`/api/v1/assets/items/${id}${qs}`);
  },
  createItem: (payload: UpsertItemInput) =>
    request<{ item: ItemView }>(`/api/v1/assets/items?today=${getLocalTodayString()}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateItem: (id: number, payload: UpsertItemInput) =>
    request<{ item: ItemView }>(`/api/v1/assets/items/${id}?today=${getLocalTodayString()}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteItem: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/assets/items/${id}`, { method: 'DELETE' }),
  useItem: (id: number, payload: UseItemInput = { delta: 1 }) =>
    request<{ item: ItemView }>(`/api/v1/assets/items/${id}/use?today=${getLocalTodayString()}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  retireItem: (id: number, payload: RetireItemInput) =>
    request<{ item: ItemView }>(`/api/v1/assets/items/${id}/retire?today=${getLocalTodayString()}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  unretireItem: (id: number) =>
    request<{ item: ItemView }>(`/api/v1/assets/items/${id}/unretire?today=${getLocalTodayString()}`, {
      method: 'POST',
    }),
  reorderItems: (ids: number[]) =>
    request<{ ok: boolean }>('/api/v1/assets/items/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  batchItems: (payload: BatchItemInput) =>
    request<{ ok: boolean; affected: number }>(`/api/v1/assets/items/batch?today=${getLocalTodayString()}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Transactions
  createTransaction: (itemId: number, payload: UpsertTransactionInput) =>
    request<{ transaction: TransactionView }>(
      `/api/v1/assets/items/${itemId}/transactions?today=${getLocalTodayString()}`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
  updateTransaction: (itemId: number, txId: number, payload: UpsertTransactionInput) =>
    request<{ transaction: TransactionView }>(
      `/api/v1/assets/items/${itemId}/transactions/${txId}?today=${getLocalTodayString()}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    ),
  deleteTransaction: (itemId: number, txId: number) =>
    request<{ ok: boolean }>(`/api/v1/assets/items/${itemId}/transactions/${txId}`, {
      method: 'DELETE',
    }),
};

// Display helpers

export function currencySymbol(c: Currency | string): string {
  switch (c) {
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    default:
      return '¥';
  }
}

export function formatMoney(amount: number, currency: Currency | string, hidden = false): string {
  if (hidden) return `${currencySymbol(currency)}****`;
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: abs >= 1000 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${currencySymbol(currency)}${formatted}`;
}

export function formatMoneyExact(amount: number, currency: Currency | string, hidden = false): string {
  if (hidden) return `${currencySymbol(currency)}****`;
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  return `${sign}${currencySymbol(currency)}${abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  active: '服役中',
  favorite: '收藏',
  retired: '已退役',
};

export const RETIRE_REASON_LABELS: Record<RetireReason, string> = {
  sold: '卖出',
  gifted: '赠送',
  lost: '遗失',
  expired: '过期',
  discarded: '丢弃',
  other: '其他',
};

export const PRICING_MODE_LABELS: Record<PricingMode, string> = {
  time: '按时间计价',
  usage: '按次计价',
  none: '不计价',
};

export const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'manual', label: '默认（手动）' },
  { value: 'status_priority', label: '状态优先' },
  { value: 'created_at', label: '添加时间' },
  { value: 'updated_at', label: '修改时间' },
  { value: 'price', label: '价格' },
  { value: 'daily_cost', label: '日均价格' },
  { value: 'usage_count', label: '使用次数' },
  { value: 'holding_days', label: '持有天数' },
  { value: 'expected_retire_at', label: '预计退役日期' },
  { value: 'warranty_until', label: '保修/到期日期' },
];

export function formatWarrantyLabel(
  status: WarrantyStatus,
  daysLeft?: number,
): { text: string; tone: 'emerald' | 'amber' | 'red' | 'neutral' } | null {
  if (status === 'none' || daysLeft === undefined) return null;
  if (daysLeft < 0) {
    return { text: `已过保 ${Math.abs(daysLeft)} 天`, tone: 'red' };
  }
  if (daysLeft === 0) {
    return { text: '今天到期', tone: 'red' };
  }
  if (daysLeft === 1) {
    return { text: '明天到期', tone: 'amber' };
  }
  if (daysLeft <= 30) {
    return { text: `${daysLeft} 天后到期`, tone: 'amber' };
  }
  return { text: `保修剩 ${daysLeft} 天`, tone: 'emerald' };
}

export function buildCategorySelectOptions(
  categories: CategoryView[],
  emptyLabel: string,
  includeUncategorized = false,
): Array<{ value: string; label: string }> {
  const topCats = categories.filter((c) => !c.parent_id);
  const subsByParent = new Map<number, CategoryView[]>();
  for (const c of categories) {
    if (c.parent_id) {
      const list = subsByParent.get(c.parent_id) ?? [];
      list.push(c);
      subsByParent.set(c.parent_id, list);
    }
  }
  const opts: Array<{ value: string; label: string }> = [{ value: '', label: emptyLabel }];
  if (includeUncategorized) {
    opts.push({ value: 'uncategorized', label: '未分类' });
  }
  for (const c of topCats) {
    opts.push({ value: String(c.id), label: c.name });
    for (const sc of subsByParent.get(c.id) ?? []) {
      opts.push({ value: String(sc.id), label: `└ ${sc.name}` });
    }
  }
  return opts;
}

export const CURRENCY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'CNY', label: 'CNY ¥' },
  { value: 'USD', label: 'USD $' },
  { value: 'EUR', label: 'EUR €' },
];

