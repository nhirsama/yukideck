import { apiUrl, request } from '@/core/api';
import type {
  ClipboardEvent,
  ClipboardItem,
  ClipboardMeta,
  CreateItemInput,
  ItemResponse,
  ListItemsResponse,
  OKResponse,
  PatchItemInput,
  ReorderItemsInput,
  UpdateItemInput,
} from './api.gen';

export type {
  ClipboardEvent,
  ClipboardItem,
  ClipboardMeta,
  CreateItemInput,
  ItemResponse,
  ListItemsResponse,
  OKResponse,
  PatchItemInput,
  ReorderItemsInput,
  UpdateItemInput,
};

export type SortBy = 'updated_at' | 'created_at' | 'expires_at' | 'manual';
export type SortDir = 'asc' | 'desc';
export type ViewMode = 'card' | 'list';

export interface ClipboardItemQuery {
  q?: string;
  starred?: boolean;
  sort_by?: SortBy;
  sort_dir?: SortDir;
}

export const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'manual', label: '手动排序' },
  { value: 'updated_at', label: '最近更新' },
  { value: 'created_at', label: '创建时间' },
  { value: 'expires_at', label: '即将到期' },
];

export const DEFAULT_MAX_BYTES = 256 * 1024;
export const SSE_INLINE_MAX_BYTES = 64 * 1024;

function createTabClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const CLIPBOARD_CLIENT_ID = createTabClientId();

const textEncoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

export function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 45) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)} 天前`;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function formatExpiryBadge(iso: string): {
  text: string;
  tone: 'red' | 'amber' | 'neutral';
} {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) {
    return { text: '未知到期', tone: 'neutral' };
  }
  const diffMs = ts - Date.now();
  if (diffMs <= 0) {
    return { text: '已过期', tone: 'red' };
  }
  const diffMin = Math.ceil(diffMs / 60_000);
  if (diffMin < 60) {
    return { text: `${diffMin} 分钟后过期`, tone: 'red' };
  }
  const diffHours = Math.floor(diffMs / 3_600_000);
  if (diffHours < 6) {
    return { text: `${diffHours} 小时后过期`, tone: 'amber' };
  }
  if (diffHours < 48) {
    return { text: `${diffHours} 小时后过期`, tone: 'neutral' };
  }
  const diffDays = Math.ceil(diffMs / 86_400_000);
  return { text: `${diffDays} 天后过期`, tone: 'neutral' };
}

export function formatDateTimeFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function toLocalDateTimeInput(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

export function getMaxExpiryDate(now = new Date()): Date {
  const max = new Date(now.getTime());
  max.setFullYear(max.getFullYear() + 1);
  // Keep 1 minute inside server limit to avoid client/server clock drift.
  max.setMinutes(max.getMinutes() - 1);
  return max;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fallback below for non-secure contexts or restricted clipboard APIs.
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) {
    throw new Error('浏览器禁止了剪贴板写入，请手动复制');
  }
}

export const clipboardApi = {
  getMeta: () => request<ClipboardMeta>('/api/v1/clipboard/meta'),

  listItems: (query: ClipboardItemQuery = {}) => {
    const params = new URLSearchParams();
    if (query.q?.trim()) params.set('q', query.q.trim());
    if (query.starred) params.set('starred', 'true');
    if (query.sort_by) params.set('sort_by', query.sort_by);
    if (query.sort_dir) params.set('sort_dir', query.sort_dir);
    const qs = params.toString();
    return request<ListItemsResponse>(`/api/v1/clipboard/items${qs ? `?${qs}` : ''}`);
  },

  getItem: (id: number) => request<ItemResponse>(`/api/v1/clipboard/items/${id}`),

  createItem: (payload: CreateItemInput) =>
    request<ItemResponse>('/api/v1/clipboard/items', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        client_id: payload.client_id ?? CLIPBOARD_CLIENT_ID,
      }),
    }),

  updateItem: (id: number, payload: UpdateItemInput) =>
    request<ItemResponse>(`/api/v1/clipboard/items/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...payload,
        client_id: payload.client_id ?? CLIPBOARD_CLIENT_ID,
      }),
    }),

  patchItem: (id: number, payload: PatchItemInput) =>
    request<ItemResponse>(`/api/v1/clipboard/items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...payload,
        client_id: payload.client_id ?? CLIPBOARD_CLIENT_ID,
      }),
    }),

  deleteItem: (id: number) =>
    request<OKResponse>(
      `/api/v1/clipboard/items/${id}?client_id=${encodeURIComponent(CLIPBOARD_CLIENT_ID)}`,
      { method: 'DELETE' },
    ),

  reorderItems: (ids: number[]) =>
    request<OKResponse>('/api/v1/clipboard/items/reorder', {
      method: 'POST',
      body: JSON.stringify({
        ids,
        client_id: CLIPBOARD_CLIENT_ID,
      } satisfies ReorderItemsInput),
    }),

  eventsUrl: (clientId = CLIPBOARD_CLIENT_ID) =>
    apiUrl(`/api/v1/clipboard/events?client_id=${encodeURIComponent(clientId)}`),
};
