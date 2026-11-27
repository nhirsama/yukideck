import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  Clock,
  Copy,
  GripVertical,
  History,
  LayoutGrid,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { LoadingState } from '@/components/LoadingState';
import { Select } from '@/components/Select';
import { Tooltip } from '@/components/Tooltip';
import { useToast } from '@/components/Toast';
import { useIsTouchDevice } from '@/core/responsive';
import {
  DEFAULT_MAX_BYTES,
  SORT_OPTIONS,
  clipboardApi,
  copyTextToClipboard,
  formatBytes,
  formatExpiryBadge,
  formatRelativeTime,
  utf8ByteLength,
  type ClipboardEvent as ClipboardSSEEvent,
  type ClipboardItem,
  type ClipboardItemQuery,
  type ListItemsResponse,
  type SortBy,
  type ViewMode,
} from './api';
import { ExpiryModal } from './components/ExpiryModal';
import { useClipboardEvents } from './realtime';

const SEARCH_HISTORY_KEY = 'yukideck_clipboard_search_history';
const VIEW_MODE_KEY = 'yukideck_clipboard_view_mode';

const SORT_SELECT_OPTIONS = SORT_OPTIONS.map((o) => ({
  value: o.value,
  label: `排序：${o.label}`,
}));

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

function loadViewMode(): ViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY);
    return raw === 'list' ? 'list' : 'card';
  } catch {
    return 'card';
  }
}

function useWaterfallColumns(): number {
  const getCols = () => {
    if (typeof window === 'undefined') return 3;
    if (window.innerWidth >= 1024) return 3;
    if (window.innerWidth >= 640) return 2;
    return 1;
  };
  const [cols, setCols] = useState(getCols);
  useEffect(() => {
    const onResize = () => setCols(getCols());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return cols;
}

function estimateCardWeight(item: ClipboardItem): number {
  const text = item.preview || '';
  const rawLines = text.split('\n');
  let visualLines = 0;
  for (const line of rawLines) {
    visualLines += Math.max(1, Math.ceil(line.length / 36));
    if (visualLines >= 10) {
      visualLines = 10;
      break;
    }
  }
  // Base chrome (header + padding + footer) + estimated preview lines
  return 4 + Math.max(1, visualLines);
}

function reorderList(items: ClipboardItem[], fromId: number, toId: number): number[] | null {
  if (fromId === toId) return null;
  const ids = items.map((x) => x.id);
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return null;
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, fromId);
  return ids;
}

function sortItemsLocal(items: ClipboardItem[], query: ClipboardItemQuery): ClipboardItem[] {
  const field = query.sort_by ?? 'manual';
  const dir = query.sort_dir ?? (field === 'manual' || field === 'expires_at' ? 'asc' : 'desc');
  const asc = dir === 'asc';
  return [...items].sort((a, b) => {
    if (a.starred !== b.starred) return a.starred ? -1 : 1;
    let cmp = 0;
    if (field === 'manual') {
      cmp = a.sort_order - b.sort_order;
    } else if (field === 'created_at') {
      cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    } else if (field === 'expires_at') {
      cmp = new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
    } else {
      cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
    }
    if (cmp !== 0) return asc ? cmp : -cmp;
    return b.id - a.id;
  });
}

export default function ClipboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const isTouch = useIsTouchDevice();
  const colCount = useWaterfallColumns();

  const [query, setQuery] = useState<ClipboardItemQuery>({
    sort_by: 'manual',
    sort_dir: 'asc',
  });
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [searchInput, setSearchInput] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<string[]>(loadSearchHistory);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [expiryTarget, setExpiryTarget] = useState<ClipboardItem | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

  const searchWrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const { data: meta } = useQuery({
    queryKey: ['clipboard', 'meta'],
    queryFn: clipboardApi.getMeta,
    staleTime: 300_000,
  });

  const maxBytes = meta?.max_bytes ?? DEFAULT_MAX_BYTES;

  const { data: itemsRes, isLoading } = useQuery({
    queryKey: ['clipboard', 'items', query],
    queryFn: () => clipboardApi.listItems(query),
  });

  const items = itemsRes?.items ?? [];

  // Live SSE updates across devices/tabs.
  const handleSSE = useCallback(
    (_ev: ClipboardSSEEvent) => {
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
    },
    [qc],
  );
  const { connected } = useClipboardEvents(handleSSE);

  // Close popovers on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (searchWrapRef.current && !searchWrapRef.current.contains(target)) {
        setHistoryOpen(false);
      }
      if (menuRef.current && !menuRef.current.contains(target)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Debounced live keyword search.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const clean = searchInput.trim();
      setQuery((prev) => {
        if ((prev.q ?? '') === clean) return prev;
        return { ...prev, q: clean || undefined };
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Mutations
  const createFromPasteMut = useMutation({
    mutationFn: (content: string) => clipboardApi.createItem({ content }),
    onMutate: (content) => {
      void qc.cancelQueries({ queryKey: ['clipboard', 'items'] });
      const tempId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
      const now = new Date();
      const nowIso = now.toISOString();
      const expIso = new Date(now.getTime() + 24 * 3_600_000).toISOString();
      const byteSize = utf8ByteLength(content);
      const preview = content.length > 600 ? content.slice(0, 600) : content;
      const lineCount = content === '' ? 0 : content.split('\n').length;

      const queries = qc.getQueriesData<ListItemsResponse>({ queryKey: ['clipboard', 'items'] });
      for (const [key, data] of queries) {
        if (!data) continue;
        const q = (key[2] as ClipboardItemQuery | undefined) ?? {};
        if (q.starred) continue;
        if (q.q && !content.toLowerCase().includes(q.q.toLowerCase())) continue;

        let minSort = 0;
        for (const it of data.items) {
          if (it.sort_order < minSort) minSort = it.sort_order;
        }
        const optimisticItem: ClipboardItem = {
          id: tempId,
          content,
          preview,
          content_omitted: false,
          byte_size: byteSize,
          char_count: content.length,
          line_count: lineCount,
          starred: false,
          sort_order: minSort - 1,
          version: 1,
          expires_at: expIso,
          created_at: nowIso,
          updated_at: nowIso,
        };
        const nextItems = sortItemsLocal([optimisticItem, ...data.items], q);
        qc.setQueryData<ListItemsResponse>(key, {
          items: nextItems,
          total: nextItems.length,
        });
      }

      return { tempId };
    },
    onSuccess: (res, _content, ctx) => {
      if (ctx?.tempId !== undefined) {
        const queries = qc.getQueriesData<ListItemsResponse>({ queryKey: ['clipboard', 'items'] });
        for (const [key, data] of queries) {
          if (!data) continue;
          const q = (key[2] as ClipboardItemQuery | undefined) ?? {};
          const replaced = data.items.some((it) => it.id === ctx.tempId)
            ? data.items.map((it) => (it.id === ctx.tempId ? res.item : it))
            : data.items;
          const nextItems = sortItemsLocal(replaced, q);
          qc.setQueryData<ListItemsResponse>(key, {
            items: nextItems,
            total: nextItems.length,
          });
        }
      }
      showToast('已从剪贴板创建文本');
    },
    onError: (err: Error, _content, ctx) => {
      if (ctx?.tempId !== undefined) {
        const queries = qc.getQueriesData<ListItemsResponse>({ queryKey: ['clipboard', 'items'] });
        for (const [key, data] of queries) {
          if (!data) continue;
          const nextItems = data.items.filter((it) => it.id !== ctx.tempId);
          qc.setQueryData<ListItemsResponse>(key, {
            items: nextItems,
            total: nextItems.length,
          });
        }
      }
      showToast(err.message, 'error');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
    },
  });

  const patchMut = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: number;
      patch: { starred?: boolean; expires_at?: string };
    }) => clipboardApi.patchItem(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ['clipboard', 'items'] });
      const previous = qc.getQueriesData<ListItemsResponse>({ queryKey: ['clipboard', 'items'] });
      const nowIso = new Date().toISOString();

      for (const [key, data] of previous) {
        if (!data) continue;
        const q = (key[2] as ClipboardItemQuery | undefined) ?? {};
        const nextItems = sortItemsLocal(
          data.items
            .map((it) =>
              it.id === id
                ? {
                    ...it,
                    starred: patch.starred !== undefined ? patch.starred : it.starred,
                    expires_at: patch.expires_at !== undefined ? patch.expires_at : it.expires_at,
                    updated_at: nowIso,
                  }
                : it,
            )
            .filter((it) => !(q.starred && !it.starred)),
          q,
        );
        qc.setQueryData<ListItemsResponse>(key, {
          items: nextItems,
          total: nextItems.length,
        });
      }

      if (patch.expires_at) {
        setExpiryTarget(null);
      }
      return { previous };
    },
    onSuccess: (_res, vars) => {
      if (vars.patch.expires_at) {
        showToast('已更新到期时间');
      }
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.previous) {
        for (const [key, data] of ctx.previous) {
          qc.setQueryData(key, data);
        }
      }
      showToast(err.message, 'error');
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
      void qc.invalidateQueries({ queryKey: ['clipboard', 'item', vars.id] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => clipboardApi.deleteItem(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['clipboard', 'items'] });
      const previous = qc.getQueriesData<ListItemsResponse>({ queryKey: ['clipboard', 'items'] });
      for (const [key, data] of previous) {
        if (!data) continue;
        const nextItems = data.items.filter((it) => it.id !== id);
        qc.setQueryData<ListItemsResponse>(key, {
          items: nextItems,
          total: nextItems.length,
        });
      }
      return { previous };
    },
    onSuccess: () => {
      showToast('已删除');
    },
    onError: (err: Error, _id, ctx) => {
      if (ctx?.previous) {
        for (const [key, data] of ctx.previous) {
          qc.setQueryData(key, data);
        }
      }
      showToast(err.message, 'error');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
    },
  });

  const reorderMut = useMutation({
    mutationFn: (ids: number[]) => clipboardApi.reorderItems(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ['clipboard', 'items'] });
      const previous = qc.getQueriesData<ListItemsResponse>({ queryKey: ['clipboard', 'items'] });
      const orderMap = new Map<number, number>(ids.map((id, idx) => [id, idx]));
      for (const [key, data] of previous) {
        if (!data) continue;
        const q = (key[2] as ClipboardItemQuery | undefined) ?? {};
        const nextItems = sortItemsLocal(
          data.items.map((it) =>
            orderMap.has(it.id) ? { ...it, sort_order: orderMap.get(it.id)! } : it,
          ),
          q,
        );
        qc.setQueryData<ListItemsResponse>(key, {
          items: nextItems,
          total: nextItems.length,
        });
      }
      return { previous };
    },
    onError: (err: Error, _ids, ctx) => {
      if (ctx?.previous) {
        for (const [key, data] of ctx.previous) {
          qc.setQueryData(key, data);
        }
      }
      showToast(err.message, 'error');
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['clipboard', 'items'] });
    },
  });

  // Global Ctrl/Cmd+V quick create when not typing in an input.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      const bytes = utf8ByteLength(text);
      if (bytes > maxBytes) {
        showToast(
          `粘贴内容超出限制（当前 ${formatBytes(bytes)}，上限 ${formatBytes(maxBytes)}）`,
          'error',
        );
        return;
      }
      createFromPasteMut.mutate(text);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [maxBytes, createFromPasteMut, showToast]);

  const commitSearch = (term: string) => {
    const clean = term.trim();
    setSearchInput(clean);
    setQuery((prev) => ({ ...prev, q: clean || undefined }));
    setHistoryOpen(false);
    if (clean) {
      const next = [clean, ...history.filter((h) => h !== clean)].slice(0, 8);
      setHistory(next);
      saveSearchHistory(next);
    }
  };

  const handleChangeView = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // ignore
    }
  };

  const handleCopyItem = useCallback(
    async (item: ClipboardItem, toastText = '已复制到剪贴板') => {
      try {
        let text = item.content;
        if (item.content_omitted && item.id > 0) {
          const full = await clipboardApi.getItem(item.id);
          text = full.item.content;
        }
        if (!text) return;
        await copyTextToClipboard(text);
        setCopiedId(item.id);
        showToast(toastText);
        window.setTimeout(() => {
          setCopiedId((cur) => (cur === item.id ? null : cur));
        }, 1500);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '复制失败', 'error');
      }
    },
    [showToast],
  );

  // Global Ctrl/Cmd+C copies the latest clipboard item when nothing is selected and list is non-empty.
  const latestItemsRef = useRef<ClipboardItem[]>(items);
  latestItemsRef.current = items;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (expiryTarget !== null) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'c') return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const selection = window.getSelection()?.toString();
      if (selection && selection.length > 0) {
        return;
      }

      const list = latestItemsRef.current;
      if (list.length === 0) return;

      let latest = list[0];
      let latestUpdated = new Date(latest.updated_at).getTime();
      for (let i = 1; i < list.length; i++) {
        const candidate = list[i];
        const ts = new Date(candidate.updated_at).getTime();
        if (ts > latestUpdated || (ts === latestUpdated && candidate.id > latest.id)) {
          latest = candidate;
          latestUpdated = ts;
        }
      }

      if (!latest.content_omitted && !latest.content) {
        return;
      }

      e.preventDefault();
      void handleCopyItem(latest, '已复制最新剪切板内容');
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expiryTarget, handleCopyItem]);

  const handleOpenEditor = (id: number) => {
    if (id <= 0) return;
    navigate(`/clipboard/${id}`);
  };

  const sortBy = query.sort_by ?? 'manual';
  const sortDir = query.sort_dir ?? (sortBy === 'manual' || sortBy === 'expires_at' ? 'asc' : 'desc');
  const canDrag = !isTouch && sortBy === 'manual' && sortDir === 'asc';

  const hasFilters = Boolean(query.q) || Boolean(query.starred);

  // Balanced N-column waterfall distribution (shortest column next, matching storage module)
  const waterfallColumns = useMemo(() => {
    const cols: ClipboardItem[][] = Array.from({ length: colCount }, () => []);
    const heights: number[] = Array.from({ length: colCount }, () => 0);

    for (const item of items) {
      let minIdx = 0;
      for (let i = 1; i < colCount; i++) {
        if (heights[i] < heights[minIdx]) minIdx = i;
      }
      cols[minIdx].push(item);
      heights[minIdx] += estimateCardWeight(item);
    }
    return cols;
  }, [items, colCount]);

  const handleDropReorder = (targetId: number) => {
    if (!canDrag || dragId == null || dragId <= 0 || targetId <= 0) return;
    const fromItem = items.find((x) => x.id === dragId);
    const toItem = items.find((x) => x.id === targetId);
    setDragId(null);
    setOverId(null);
    if (!fromItem || !toItem || fromItem.id === toItem.id) return;
    if (fromItem.starred !== toItem.starred) {
      showToast('星标项始终置顶，请在同组内拖拽调整顺序', 'info');
      return;
    }
    const next = reorderList(items, fromItem.id, toItem.id);
    if (next) reorderMut.mutate(next);
  };

  const renderActionBar = (item: ClipboardItem, compact = false) => {
    const menuOpen = openMenuId === item.id;
    const isCopied = copiedId === item.id;
    const isPending = item.id <= 0;

    return (
      <div
        className={`flex items-center gap-0.5 shrink-0 ${compact ? '' : 'justify-end'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip content={item.starred ? '取消星标' : '星标置顶'}>
          <button
            type="button"
            disabled={isPending}
            onClick={() => patchMut.mutate({ id: item.id, patch: { starred: !item.starred } })}
            className={`yd-btn-icon ${
              item.starred ? 'text-amber-500 hover:bg-amber-50 hover:text-amber-600' : ''
            }`}
            aria-label={item.starred ? '取消星标' : '星标置顶'}
          >
            <Star className={`h-3.5 w-3.5 ${item.starred ? 'fill-amber-400' : ''}`} />
          </button>
        </Tooltip>

        <Tooltip content={isCopied ? '已复制' : '复制全文'}>
          <button
            type="button"
            onClick={() => void handleCopyItem(item)}
            className={`yd-btn-icon ${
              isCopied ? 'text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700' : ''
            }`}
            aria-label="复制全文"
          >
            {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </Tooltip>

        <Tooltip content="编辑">
          <button
            type="button"
            disabled={isPending}
            onClick={() => handleOpenEditor(item.id)}
            className="yd-btn-icon"
            aria-label="编辑"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </Tooltip>

        <div className="relative" ref={menuOpen ? menuRef : undefined}>
          <Tooltip content="更多操作" disabled={menuOpen || isPending}>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setOpenMenuId(menuOpen ? null : item.id)}
              className="yd-btn-icon"
              aria-label="更多操作"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </Tooltip>

          {menuOpen && (
            <div className="absolute right-0 mt-1.5 w-36 rounded-xl border border-zinc-200/90 bg-white py-1 shadow-lg z-30">
              <button
                type="button"
                onClick={() => {
                  setOpenMenuId(null);
                  setExpiryTarget(item);
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-50 flex items-center gap-2"
              >
                <Clock className="h-3.5 w-3.5 text-sky-500 shrink-0" />
                更改到期时间
              </button>
              <div className="my-1 border-t border-zinc-100" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenuId(null);
                  deleteMut.mutate(item.id);
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 flex items-center gap-2"
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                删除
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderExpiryBadge = (expiresAt: string) => {
    const info = formatExpiryBadge(expiresAt);
    const cls =
      info.tone === 'red'
        ? 'yd-badge-red'
        : info.tone === 'amber'
          ? 'yd-badge-amber'
          : 'yd-badge-neutral';
    return (
      <span className={`yd-badge ${cls} tabular-nums`}>
        <Clock className="h-3 w-3" />
        {info.text}
      </span>
    );
  };

  const filteredHistory = useMemo(
    () =>
      history.filter(
        (h) => !searchInput.trim() || h.toLowerCase().includes(searchInput.trim().toLowerCase()),
      ),
    [history, searchInput],
  );

  return (
    <div className="space-y-5 pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="yd-page-title">剪切板</h1>
          <Tooltip content={connected ? 'SSE 实时同步已连接' : '正在连接实时同步...'}>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200/80 bg-white px-2.5 py-0.5 text-[11px] text-zinc-500">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connected ? 'bg-emerald-500' : 'bg-zinc-300 animate-pulse'
                }`}
              />
              {connected ? '实时同步' : '连接中'}
            </span>
          </Tooltip>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden sm:inline text-xs text-zinc-400">
            Ctrl+V 粘贴新建 · Ctrl+C 复制最新 · 上限 {formatBytes(maxBytes)}
          </span>
          <button
            type="button"
            onClick={() => navigate('/clipboard/new')}
            className="yd-btn-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            新建文本
          </button>
        </div>
      </div>

      {/* Filter & Sort Toolbar (inspired by assets FilterBar) */}
      <div className="yd-card p-3 flex flex-wrap items-center gap-2.5">
        {/* Search Input + History */}
        <div className="relative flex-1 min-w-[200px]" ref={searchWrapRef}>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={searchInput}
            onFocus={() => setHistoryOpen(true)}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitSearch(searchInput);
              }
            }}
            placeholder="搜索正文关键词..."
            className="yd-input-sm w-full pl-8 pr-7"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                setQuery((prev) => ({ ...prev, q: undefined }));
              }}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-600"
              aria-label="清空搜索"
            >
              <X className="h-3 w-3" />
            </button>
          )}

          {historyOpen && filteredHistory.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1.5 rounded-xl border border-zinc-200/90 bg-white py-1.5 shadow-lg z-30">
              <div className="flex items-center justify-between px-3 pb-1 text-[11px] text-zinc-400">
                <span className="inline-flex items-center gap-1">
                  <History className="h-3 w-3" />
                  搜索历史
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setHistory([]);
                    saveSearchHistory([]);
                  }}
                  className="hover:text-zinc-600"
                >
                  清空
                </button>
              </div>
              {filteredHistory.map((term) => (
                <div
                  key={term}
                  className="flex items-center justify-between px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
                >
                  <button
                    type="button"
                    onClick={() => commitSearch(term)}
                    className="flex-1 text-left truncate"
                  >
                    {term}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const next = history.filter((h) => h !== term);
                      setHistory(next);
                      saveSearchHistory(next);
                    }}
                    className="ml-2 text-zinc-400 hover:text-zinc-600"
                    aria-label="移除历史"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* All / Starred segment */}
        <div className="yd-segment">
          <button
            type="button"
            onClick={() => setQuery((prev) => ({ ...prev, starred: undefined }))}
            className={`yd-segment-btn ${!query.starred ? 'yd-segment-active' : 'yd-segment-idle'}`}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => setQuery((prev) => ({ ...prev, starred: true }))}
            className={`yd-segment-btn inline-flex items-center gap-1 ${
              query.starred ? 'yd-segment-active' : 'yd-segment-idle'
            }`}
          >
            <Star className="h-3 w-3" />
            星标
          </button>
        </div>

        {/* Sort selector + direction */}
        <div className="flex items-center gap-1">
          <div className="w-36">
            <Select
              value={sortBy}
              onChange={(val) => {
                const nextSort = val as SortBy;
                const defaultDir = nextSort === 'manual' || nextSort === 'expires_at' ? 'asc' : 'desc';
                setQuery((prev) => ({ ...prev, sort_by: nextSort, sort_dir: defaultDir }));
              }}
              options={SORT_SELECT_OPTIONS}
              size="sm"
            />
          </div>
          <Tooltip content={sortDir === 'asc' ? '当前升序，点击切换降序' : '当前降序，点击切换升序'}>
            <button
              type="button"
              onClick={() =>
                setQuery((prev) => ({
                  ...prev,
                  sort_dir: sortDir === 'asc' ? 'desc' : 'asc',
                }))
              }
              className="yd-btn-secondary px-2 py-1.5"
              aria-label="切换排序方向"
            >
              {sortDir === 'asc' ? (
                <ArrowUpNarrowWide className="h-3.5 w-3.5" />
              ) : (
                <ArrowDownWideNarrow className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        </div>

        {/* Card / List view switch */}
        <div className="yd-segment">
          <Tooltip content="卡片视图">
            <button
              type="button"
              onClick={() => handleChangeView('card')}
              className={`yd-segment-btn px-2 ${viewMode === 'card' ? 'yd-segment-active' : 'yd-segment-idle'}`}
              aria-label="卡片视图"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="列表视图">
            <button
              type="button"
              onClick={() => handleChangeView('list')}
              className={`yd-segment-btn px-2 ${viewMode === 'list' ? 'yd-segment-active' : 'yd-segment-idle'}`}
              aria-label="列表视图"
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Content List / Cards */}
      {isLoading ? (
        <LoadingState label="正在加载剪切板..." variant="section" />
      ) : items.length === 0 ? (
        <div className="yd-empty p-10 space-y-2">
          <p className="text-sm text-zinc-500">
            {hasFilters ? '当前筛选下没有匹配的文本。' : '还没有保存任何剪切板文本。'}
          </p>
          <p className="text-xs text-zinc-400">
            {hasFilters
              ? '尝试调整关键词或切换回「全部」。'
              : '点击右上角「新建文本」，或直接按 Ctrl+V 粘贴文字即可快速保存（默认保留 24 小时）。'}
          </p>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                setQuery((prev) => ({ ...prev, q: undefined, starred: undefined }));
              }}
              className="yd-btn-secondary mt-2"
            >
              清除筛选
            </button>
          )}
        </div>
      ) : viewMode === 'card' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
          {waterfallColumns.map((colItems, colIdx) => (
            <div key={colIdx} className="flex flex-col gap-3 min-w-0">
              {colItems.map((item) => {
                const isDragging = dragId === item.id;
                const isOver = overId === item.id && dragId !== item.id;
                return (
                  <div
                    key={item.id}
                    draggable={canDrag}
                    onDragStart={(e) => {
                      if (!canDrag) return;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(item.id));
                      setDragId(item.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                    }}
                    onDragOver={(e) => {
                      if (!canDrag) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (overId !== item.id) setOverId(item.id);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleDropReorder(item.id);
                    }}
                    onClick={() => handleOpenEditor(item.id)}
                    className={`yd-card-interactive relative flex cursor-pointer flex-col justify-between gap-3 p-4 ${
                      isDragging ? 'opacity-50' : ''
                    } ${isOver ? 'border-sky-400 ring-2 ring-sky-200' : ''}`}
                  >
                    {/* Preview Body */}
                    <div className="space-y-2 min-w-0">
                      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {canDrag && (
                            <Tooltip content="拖拽调整顺序">
                              <div
                                className="cursor-grab text-zinc-300 hover:text-zinc-500 active:cursor-grabbing shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <GripVertical className="h-3.5 w-3.5" />
                              </div>
                            </Tooltip>
                          )}
                          {item.starred && (
                            <span className="yd-badge yd-badge-amber">星标</span>
                          )}
                          <span className="truncate">{formatRelativeTime(item.updated_at)}</span>
                        </div>
                        <span className="font-mono shrink-0">
                          {item.char_count} 字 · {formatBytes(item.byte_size)}
                        </span>
                      </div>

                      <pre className="line-clamp-10 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-zinc-800">
                        {item.preview || '（空白文本）'}
                      </pre>
                    </div>

                    {/* Card Footer */}
                    <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-2.5">
                      {renderExpiryBadge(item.expires_at)}
                      {renderActionBar(item)}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const isDragging = dragId === item.id;
            const isOver = overId === item.id && dragId !== item.id;
            return (
              <div
                key={item.id}
                draggable={canDrag}
                onDragStart={(e) => {
                  if (!canDrag) return;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(item.id));
                  setDragId(item.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  if (!canDrag) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overId !== item.id) setOverId(item.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDropReorder(item.id);
                }}
                onClick={() => handleOpenEditor(item.id)}
                className={`yd-card-interactive cursor-pointer p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-2.5 sm:gap-4 ${
                  isDragging ? 'opacity-50' : ''
                } ${isOver ? 'border-sky-400 ring-2 ring-sky-200' : ''}`}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-start gap-2">
                    {canDrag && (
                      <Tooltip content="拖拽调整顺序">
                        <div
                          className="mt-0.5 cursor-grab text-zinc-300 hover:text-zinc-500 active:cursor-grabbing shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <GripVertical className="h-4 w-4" />
                        </div>
                      </Tooltip>
                    )}
                    <pre className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-zinc-800 flex-1 min-w-0">
                      {item.preview || '（空白文本）'}
                    </pre>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                    {item.starred && <span className="yd-badge yd-badge-amber">星标</span>}
                    {renderExpiryBadge(item.expires_at)}
                    <span className="yd-badge yd-badge-neutral font-mono">
                      {item.char_count} 字 · {formatBytes(item.byte_size)}
                    </span>
                    <span className="text-zinc-400 ml-0.5">
                      更新于 {formatRelativeTime(item.updated_at)}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-end sm:justify-start shrink-0 pt-2 border-t border-zinc-100 sm:pt-0 sm:border-0">
                  {renderActionBar(item, true)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Expiry Modal */}
      <ExpiryModal
        open={expiryTarget !== null}
        currentExpiresAt={expiryTarget?.expires_at ?? ''}
        saving={patchMut.isPending}
        onClose={() => setExpiryTarget(null)}
        onConfirm={(iso) => {
          if (!expiryTarget) return;
          patchMut.mutate({ id: expiryTarget.id, patch: { expires_at: iso } });
        }}
      />
    </div>
  );
}
